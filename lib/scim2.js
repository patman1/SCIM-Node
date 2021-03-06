'use strict';

var fs = require('fs');
var uuid = require('uuid');
var request = require('request-promise');
var jwt = require('jsonwebtoken');
var Promise = require('bluebird');
var parsers = require('www-authenticate').parsers;

module.exports = function (params) {
  var module = {};

  /**
   * Gets configurations of UMA from domain URL
   * @param {string} domain - Gluu server domain Url
   * @returns {Promise.<umaConfigurations, error>} - A promise that returns a umaConfigurations if resolved, or an
   * Error if rejected.
   */
  function getUmaConfigurations(domain) {
    var options = {
      method: 'GET',
      url: domain.concat('/.well-known/uma2-configuration')
    };

    return new Promise(function (resolve, reject) {
      request(options)
        .then(function (umaConfigurations) {
          try {
            umaConfigurations = JSON.parse(umaConfigurations);
          } catch (ex) {
            return reject(umaConfigurations);
          }

          return resolve(umaConfigurations);
        })
        .catch(function (error) {
          return reject(error);
        });
    });
  }

  /**
   * Gets configurations of SCIM 2.0 from domain URL.
   * @param {string} domain - Gluu server domain Url
   * @returns {Promise.<scimConfigurations, error>} - A promise that returns a scimConfigurations if resolved, or an
   * Error if rejected.
   */
  function getSCIMConfigurations(domain) {
    var options = {
      method: 'GET',
      url: domain.concat('/.well-known/scim-configuration')
    };

    return new Promise(function (resolve, reject) {
      request(options)
        .then(function (scimConfigurations) {
          try {
            scimConfigurations = JSON.parse(scimConfigurations);
          } catch (ex) {
            return reject(scimConfigurations);
          }

          return resolve(scimConfigurations[0]);
        })
        .catch(function (error) {
          return reject(error);
        });
    });
  }

  function getTicketAndConfig(resourceURL) {
    var options = {
      method: 'GET',
      url: resourceURL
    };

    return new Promise(function (resolve, reject) {
      request(options)
        .then(function (data) {
          try {
            data = JSON.parse(data);
          } catch (ex) {
            reject(data.toString());
          }
          reject(resourceURL);
        })
        .catch(function (error) {
          if (error.statusCode == 401) {
            var parsed = new parsers.WWW_Authenticate(error.response.headers['www-authenticate']);
            resolve({ ticket: parsed.parms.ticket, as_URI: parsed.parms.as_uri });
          }
          else {
            reject(data.toString());
          }
        });
    });
  }
  /**
   * Gets AAT token detail.
   * @param {json} config - json of config values of Gluu client
   * @param {string} tokenEndpoint - Token endpoint URL retrieve from UMA configuration.
   * @returns {Promise<AATDetails, error>} - A promise that returns a AATDetails if resolved, or an Error if rejected.
   */
  function getToken(config, tokenEndpoint, ticket) {
    var scimCert = fs.readFileSync(config.privateKey, 'utf8'); // get private key and replace headers to sign jwt
    scimCert = scimCert.replace('-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----');
    scimCert = scimCert.replace('-----END RSA PRIVATE KEY-----', '-----END PRIVATE KEY-----');

    var optionsToken = {
      algorithm: config.keyAlg,
      header: {
        'typ': 'JWT',
        'alg': config.keyAlg,
        'kid': config.keyId
      }
    };
    var token = jwt.sign({
      iss: config.clientId,
      sub: config.clientId,
      aud: tokenEndpoint,
      jti: uuid(),
      exp: (new Date().getTime() / 1000 + 30),
      iat: (new Date().getTime())
    }, scimCert, optionsToken);

    var options = {
      method: 'POST',
      url: tokenEndpoint,
      headers: {
        'content-type': 'application/x-www-form-urlencoded'
      },
      form: {
        grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
        scope: 'uma_authorization',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: token,
        client_id: config.clientId,
        ticket: ticket.ticket
      }
    };

    return new Promise(function (resolve, reject) {
      request(options)
        .then(function (AATDetails) {
          try {
            AATDetails = JSON.parse(AATDetails);
          } catch (ex) {
            return reject(AATDetails);
          }

          if (AATDetails.error) {
            return reject(AATDetails.error);
          }

          return resolve(AATDetails);
        })
        .catch(function (error) {
          return reject(error);
        });
    });
  }

  /**
   * Gets RPT and SCIM details of Gluu client
   * @param {string} config - json of config values of Gluu client
   * @returns {Promise<rptDetail, error>} - A promise that returns a rptDetail if resolved, or an Error if rejected.
   */
  function getRPTToken(config, resourceURL) {
    return new Promise(function (resolve, reject) {
      if (!config.domain) {
        return reject('Provide valid value of domain, passed as json element "domain" of module');
      }
      if (!config.privateKey) {
        return reject('Provide valid value of privateKey, passed as json element "privateKey" of module');
      }
      if (!config.clientId) {
        return reject('Provide valid value of clientId, passed as json element "clientId" of module');
      }
      if (!config.keyAlg) {
        return reject('Provide valid value of keyAlg, passed as json element "keyAlg" of module');
      }
      if (!config.keyId) {
        return reject('Provide valid value of keyId, passed as json element "keyId" of module');
      }

      var rptDetail = {};
      return getUmaConfigurations(config.domain)
        .then(function (umaConfigurations) {
          rptDetail.umaConfiguration = umaConfigurations;
          return getTicketAndConfig(resourceURL);
        })
        .then(function (ticket) {
          rptDetail.ticket = ticket;
          return getToken(config, rptDetail.umaConfiguration.token_endpoint, rptDetail.ticket);
        })
        .then(function (rpt) {
          rptDetail.RPT = rpt;
          return resolve(rptDetail);
        })
        .catch(function (error) {
          return reject(error);
        });
    });
  }

  /**
   * Authorizes RPT token by requesting PAT using ticket number.
   * @param {GUID} aat - Access token
   * @param {json} scimResponse - json response of SCIM method call that contains ticket number.
   * @param {string} authorizationEndpoint - Authorization Endpoint URL retrieved from uma configuration
   * @returns {Promise<rptDetail, error>} - A promise that returns a rptDetail if resolved, or an Error if rejected.
   */
  function authorizeRPT(rpt, aat, scimResponse, authorizationEndpoint) {
    return new Promise(function (resolve, reject) {
      if (typeof scimResponse !== 'object') {
        try {
          scimResponse = JSON.parse(scimResponse);
        } catch (ex) {
          return reject(scimResponse);
        }
      }

      var ticket = scimResponse.ticket;
      if (!ticket) {
        return reject('Ticket not found, RPT can not authorize.');
      }

      var options = {
        method: 'POST',
        url: authorizationEndpoint,
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer '.concat(aat)
        },
        body: JSON.stringify({ ticket: ticket, rpt: rpt })
      };

      return request(options)
        .then(function (rptDetails) {
          try {
            rptDetails = JSON.parse(rptDetails);
          } catch (ex) {
            return reject(rptDetails.toString());
          }

          return resolve(rptDetails.rpt);
        })
        .catch(function (error) {
          return reject(error);
        });
    });
  }

  /**
   * Retrieves user list or total counts if count is zero or undefined.
   * @param {string} userEndpoint - User Endpoint URL of SCIM 2.0
   * @param {string} rpt - RPT token received from getRPT
   * @param {int} startIndex - page index starts with 1.
   * @param {int} count - number of users to be returned.
   * @returns {Promise<usersDetail, error>} - A promise that returns a usersDetail if resolved, or an Error if
   * rejected.
   */
  function get(endpoint, rpt, startIndex, count, filter) {
    var options = {
      method: 'GET',
      url: endpoint,
      headers: {
        'content-type': 'application/json',
        'Accept': 'application/scim+json;charset=utf-8',
        authorization: 'Bearer '.concat(rpt)
      },
      qs: {}
    };

    if (filter) {
      options.qs.filter = filter;
    }

    if (count > 0 && startIndex > 0) {
      options.qs.startIndex = startIndex;
      options.qs.count = count;
    }

    return new Promise(function (resolve, reject) {
      request(options)
        .then(function (usersDetail) {
          return resolve(usersDetail);
        })
        .catch(function (error) {
          return reject(error);
        });
    });
  }

  /**
   * Retrieves specific user.
   * @param {string} userEndpoint - User Endpoint URL of SCIM 2.0
   * @param {string} rpt - RPT token received from getRPT
   * @param {string} id - Inum of user to be retrieve
   * @returns {Promise<userDetail, error>} - A promise that returns a userDetail if resolved, or an Error if rejected.
   */
  function getById(endpoint, rpt, id, filter) {
    var options = {
      method: 'GET',
      url: endpoint.concat('/').concat(id),
      headers: {
        'content-type': 'application/json',
        'Accept': 'application/scim+json;charset=utf-8',
        authorization: 'Bearer '.concat(rpt)
      }
    };

    if (filter) {
      options.qs.filter = filter;
    }

    return new Promise(function (resolve, reject) {
      request(options)
        .then(function (userDetail) {
          return resolve(userDetail);
        })
        .catch(function (error) {
          return reject(error);
        });
    });
  }

  /**
   * Insert new user.
   * @param {string} endpoint - User Endpoint URL of SCIM 2.0
   * @param {string} rpt - RPT token received from getRPT
   * @param {object} data - User details to be inserted
   * @returns {Promise<detail, error>} - A promise that returns a userDetail if resolved, or an Error if rejected.
   */
  function insert(endpoint, rpt, data, schema) {
    data.schemas = [schema]; //'urn:ietf:params:scim:schemas:core:2.0:User'

    var options = {
      method: 'POST',
      url: endpoint,
      headers: {
        'content-type': 'application/json',
        'Accept': 'application/scim+json;charset=utf-8',
        authorization: 'Bearer '.concat(rpt)
      },
      body: JSON.stringify(data)
    };

    return new Promise(function (resolve, reject) {
      request(options)
        .then(function (detail) {
          return resolve(detail);
        })
        .catch(function (error) {
          return reject(error);
        });
    });
  }

  /**
     * Update user or group.
     * @param {string} endpoint - User or Group Endpoint URL of SCIM 2.0
     * @param {string} rpt - RPT token received from getRPT
     * @param {string} id - User or Group Inum
     * @param {object} data - User or Group details to be updated
     * @returns {Promise<detail, error>} - A promise that returns a userDetail if resolved, or an Error if rejected.
     */
  function update(endpoint, rpt, data, schema, id) {
    data.schemas = [schema];

    var options = {
      method: 'PUT',
      url: endpoint.concat('/').concat(id),
      headers: {
        'content-type': 'application/json',
        'Accept': 'application/scim+json;charset=utf-8',
        authorization: 'Bearer '.concat(rpt)
      },
      body: JSON.stringify(data)
    };

    return new Promise(function (resolve, reject) {
      request(options)
        .then(function (detail) {
          return resolve(detail);
        })
        .catch(function (error) {
          return reject(error);
        });
    });
  }

  /**
   * Delete specific user.
   * @param {string} userEndpoint - User Endpoint URL of SCIM 2.0
   * @param {string} rpt - RPT token received from getRPT
   * @param {string} id - Inum of user to be retrieve
   * @returns {Promise<userDetail, error>} - A promise that returns a userDetail if resolved, or an Error if rejected.
   */
  function _delete(endpoint, rpt, id) {
    var options = {
      method: 'DELETE',
      url: endpoint.concat('/').concat(id),
      headers: {
        'content-type': 'application/json',
        'Accept': 'application/scim+json;charset=utf-8',
        authorization: 'Bearer '.concat(rpt)
      }
    };

    return new Promise(function (resolve, reject) {
      request(options)
        .then(function (userDetail) {
          return resolve(userDetail);
        })
        .catch(function (error) {
          return reject(error);
        });
    });
  }

  /**
   * Search users.
   * @param {string} endpoint - User or Group Endpoint URL of SCIM 2.0
   * @param {string} rpt - RPT token received from getRPT
   * @param {string} filter - Search filters
   * @param {int} startIndex - page index starts with 1.
   * @param {int} count - number of users to be returned.
   * @param {string} schema - uma user search schema
   * @returns {requestCallback|Promise<object, error>} - callback or promise that returns users if resolved, or an Error if rejected.
   */
  function search(endpoint, rpt, filter, startIndex, count, schema) {
    var data = {
      schemas: [schema],
      filter: filter,
      startIndex: startIndex,
      count: count
    };

    var options = {
      method: 'POST',
      url: endpoint.concat('/').concat('.search'),
      headers: {
        'content-type': 'application/json',
        'Accept': 'application/scim+json;charset=utf-8',
        authorization: 'Bearer '.concat(rpt)
      },
      body: JSON.stringify(data)
    };

    return new Promise(function (resolve, reject) {
      request(options)
        .then(function (detail) {
          return resolve(detail);
        })
        .catch(function (error) {
          return reject(error);
        });
    });
  }

  /**
   * To return users count.
   * @param {requestCallback} [callback] - The callback that handles the response and Error.
   * @returns {requestCallback|Promise<object, error>} - callback or promise that returns users count if resolved,
   * or an Error if rejected.
   */
  module.getUsersCount = function getUsersCount(callback) {
    return new Promise(function (resolve, reject) {
      var userEndpoint = '';
      return getSCIMConfigurations(params.domain)
        .then(function (scimConfig) {
          userEndpoint = scimConfig.user_endpoint;
          return getRPTToken(params, userEndpoint);
        })
        .then(function (rptDetail) {
          return get(userEndpoint, rptDetail.RPT.access_token, 0, 0, undefined)
        })
        .then(function (users) {
          return resolve(users);
        })
        .catch(function (error) {
          if (error.statusCode === 403) {
            // return authorizeRPT(rptDetail.RPT, rptDetail.AAT, error.error, rptDetail.umaConfiguration.authorization_endpoint);
          }
          return reject(error);
        });
    }).asCallback(callback);
  };

  /**
   * To return user list.
   * @param {int} startIndex - page index starts with 1.
   * @param {int} count - number of users to be returned.
   * @param {requestCallback} [callback] - The callback that handles the response and Error.
   * @returns {requestCallback|Promise<object, error>} - callback or promise that returns users if resolved, or an Error if rejected.
   */
  module.getUsers = function getUsers(startIndex, count, filter, callback) {
    return new Promise(function (resolve, reject) {
      if (count < 0 || startIndex < 0) {
        return reject(new Error('Provide valid value of count and startIndex. Values must be greater then 0.'));
      }

      var userEndpoint = '';
      return getSCIMConfigurations(params.domain)
        .then(function (scimConfig) {
          userEndpoint = scimConfig.user_endpoint;
          return getRPTToken(params, userEndpoint);
        })
        .then(function (rptDetail) {
          return get(userEndpoint, rptDetail.RPT.access_token, startIndex, count, filter);
        })
        .then(function (users) {
          return resolve(users);
        })
        .catch(function (error) {
          if (error.statusCode === 403) {
            // return authorizeRPT(rptDetail.RPT, rptDetail.AAT, error.error, rptDetail.umaConfiguration.authorization_endpoint);
          }
          return reject(error);
        });
    }).asCallback(callback);
  };

  /**
   * Returns specific user detail.
   * @param {string} id - inum of user
   * @param {requestCallback} [callback] - The callback that handles the response and Error.
   * @returns {requestCallback|Promise<object, error>} - callback or promise that returns user detail if resolved, or an Error if rejected.
   */
  module.getUser = function getUser(id, filter, callback) {
    return new Promise(function (resolve, reject) {
      if (!id) {
        return reject(new Error('Provide valid value of id.'));
      }
      var userEndpoint = '';
      return getSCIMConfigurations(params.domain)
        .then(function (scimConfig) {
          userEndpoint = scimConfig.user_endpoint;
          return getRPTToken(params, userEndpoint);
        })
        .then(function (rptDetail) {
          return getById(userEndpoint, rptDetail.RPT.access_token, id, filter)
        })
        .then(function (users) {
          return resolve(users);
        })
        .catch(function (error) {
          if (error.statusCode === 403) {
            // return authorizeRPT(rptDetail.RPT, rptDetail.AAT, error.error, rptDetail.umaConfiguration.authorization_endpoint);
          }
          return reject(error);
        });
    }).asCallback(callback);
  };

  /**
   * To add new user.
   * @param {object} userData - Object of user details
   * @param {requestCallback} [callback] - The callback that handles the response and Error.
   * @returns {requestCallback|Promise<object, error>} - callback or promise that returns user detail if resolved, or an Error if rejected.
   */
  module.addUser = function addUser(userData, callback) {
    return new Promise(function (resolve, reject) {
      var userEndpoint = '';
      return getSCIMConfigurations(params.domain)
        .then(function (scimConfig) {
          userEndpoint = scimConfig.user_endpoint;
          return getRPTToken(params, userEndpoint);
        })
        .then(function (rptDetail) {
          return insert(userEndpoint, rptDetail.RPT.access_token, userData, 'urn:ietf:params:scim:schemas:core:2.0:User')
        })
        .then(function (users) {
          return resolve(users);
        })
        .catch(function (error) {
          if (error.statusCode === 403) {
            // return authorizeRPT(rptDetail.RPT, rptDetail.AAT, error.error, rptDetail.umaConfiguration.authorization_endpoint);
          }
          return reject(error);
        });
    }).asCallback(callback);
  };

  /**
   * To remove user.
   * @param {string} id - inum of user
   * @param {requestCallback} [callback] - The callback that handles the response and Error.
   * @returns {requestCallback|Promise<object, error>} - callback or promise that returns empty data if resolved, or an Error if rejected.
   */
  module.removeUser = function removeUser(id, callback) {
    return new Promise(function (resolve, reject) {
      if (!id) {
        return reject(new Error('Provide valid value of id.'));
      }
      var userEndpoint = '';
      return getSCIMConfigurations(params.domain)
        .then(function (scimConfig) {
          userEndpoint = scimConfig.user_endpoint;
          return getRPTToken(params, userEndpoint);
        })
        .then(function (rptDetail) {
          return _delete(userEndpoint, rptDetail.RPT.access_token, id)
        })
        .then(function (users) {
          return resolve(users);
        })
        .catch(function (error) {
          if (error.statusCode === 403) {
            // return authorizeRPT(rptDetail.RPT, rptDetail.AAT, error.error, rptDetail.umaConfiguration.authorization_endpoint);
          }
          return reject(error);
        });
    }).asCallback(callback);
  };

  /**
   * To edit user.
   * @param {string} id - inum of user
   * @param {object} userData - Object of user details
   * @param {requestCallback} [callback] - The callback that handles the response and Error.
   * @returns {requestCallback|Promise<object, error>} - callback or promise that returns user detail if resolved, or an Error if rejected.
   */
  module.editUser = function editUser(id, userData, callback) {
    return new Promise(function (resolve, reject) {
      if (!id) {
        return reject(new Error('Provide valid value of id.'));
      }
      var userEndpoint = '';
      return getSCIMConfigurations(params.domain)
        .then(function (scimConfig) {
          userEndpoint = scimConfig.user_endpoint;
          return getRPTToken(params, userEndpoint);
        })
        .then(function (rptDetail) {
          let schema = 'urn:ietf:params:scim:schemas:core:2.0:User';
          if (userData['schema']) {
            schema = userData['schema'];
            delete userData['schema'];
          }
          return update(userEndpoint, rptDetail.RPT.access_token, userData, schema, id)
        })
        .then(function (users) {
          return resolve(users);
        })
        .catch(function (error) {
          if (error.statusCode === 403) {
            // return authorizeRPT(rptDetail.RPT, rptDetail.AAT, error.error, rptDetail.umaConfiguration.authorization_endpoint);
          }
          return reject(error);
        });
    }).asCallback(callback);
  };

  /**
   * To return group count.
   * @param {requestCallback} [callback] - The callback that handles the response and Error.
   * @returns {requestCallback|Promise<object, error>} - callback or promise that returns groups count if resolved,
   * or an Error if rejected.
   */
  module.getGroupCount = function getGroupCount(callback) {
    return new Promise(function (resolve, reject) {
      var groupEndpoint = '';
      return getSCIMConfigurations(params.domain)
        .then(function (scimConfig) {
          groupEndpoint = scimConfig.group_endpoint;
          return getRPTToken(params, groupEndpoint);
        })
        .then(function (rptDetail) {
          return get(groupEndpoint, rptDetail.RPT.access_token, 0, 0, undefined)
        })
        .then(function (groups) {
          return resolve(groups);
        })
        .catch(function (error) {
          if (error.statusCode === 403) {
            // return authorizeRPT(rptDetail.RPT, rptDetail.AAT, error.error, rptDetail.umaConfiguration.authorization_endpoint);
          }
          return reject(error);
        });
    }).asCallback(callback);
  };

  /**
   * To return user list.
   * @param {int} startIndex - page index starts with 1.
   * @param {int} count - number of users to be returned.
   * @param {requestCallback} [callback] - The callback that handles the response and Error.
   * @returns {requestCallback|Promise<object, error>} - callback or promise that returns users if resolved, or an Error if rejected.
   */
  module.getGroups = function getGroups(startIndex, count, filter, callback) {
    return new Promise(function (resolve, reject) {
      if (count < 0 || startIndex < 0) {
        return reject(new Error('Provide valid value of count and startIndex. Values must be greater then 0.'));
      }

      var groupEndpoint = '';
      return getSCIMConfigurations(params.domain)
        .then(function (scimConfig) {
          groupEndpoint = scimConfig.group_endpoint;
          return getRPTToken(params, groupEndpoint);
        })
        .then(function (rptDetail) {
          return get(groupEndpoint, rptDetail.RPT.access_token, startIndex, count, filter)
        })
        .then(function (groups) {
          return resolve(groups);
        })
        .catch(function (error) {
          if (error.statusCode === 403) {
            // return authorizeRPT(rptDetail.RPT, rptDetail.AAT, error.error, rptDetail.umaConfiguration.authorization_endpoint);
          }
          return reject(error);
        });
    }).asCallback(callback);
  };

  /**
   * Returns specific user detail.
   * @param {string} id - inum of user
   * @param {requestCallback} [callback] - The callback that handles the response and Error.
   * @returns {requestCallback|Promise<object, error>} - callback or promise that returns user detail if resolved, or an Error if rejected.
   */
  module.getGroup = function getGroup(id, filter, callback) {
    return new Promise(function (resolve, reject) {
      if (!id) {
        return reject(new Error('Provide valid value of id.'));
      }
      var groupEndpoint = '';
      return getSCIMConfigurations(params.domain)
        .then(function (scimConfig) {
          groupEndpoint = scimConfig.group_endpoint;
          return getRPTToken(params, groupEndpoint);
        })
        .then(function (rptDetail) {
          return getById(groupEndpoint, rptDetail.RPT.access_token, id, filter)
        })
        .then(function (groups) {
          return resolve(groups);
        })
        .catch(function (error) {
          if (error.statusCode === 403) {
            // return authorizeRPT(rptDetail.RPT, rptDetail.AAT, error.error, rptDetail.umaConfiguration.authorization_endpoint);
          }
          return reject(error);
        });
    }).asCallback(callback);
  };

  /**
   * To add new user.
   * @param {object} userData - Object of user details
   * @param {requestCallback} [callback] - The callback that handles the response and Error.
   * @returns {requestCallback|Promise<object, error>} - callback or promise that returns user detail if resolved, or an Error if rejected.
   */
  module.addGroup = function addGroup(groupData, callback) {
    return new Promise(function (resolve, reject) {
      var groupEndpoint = '';
      return getSCIMConfigurations(params.domain)
        .then(function (scimConfig) {
          groupEndpoint = scimConfig.group_endpoint;
          return getRPTToken(params, groupEndpoint);
        })
        .then(function (rptDetail) {
          return insert(groupEndpoint, rptDetail.RPT.access_token, groupData, 'urn:ietf:params:scim:schemas:core:2.0:Group')
        })
        .then(function (groups) {
          return resolve(groups);
        })
        .catch(function (error) {
          if (error.statusCode === 403) {
            // return authorizeRPT(rptDetail.RPT, rptDetail.AAT, error.error, rptDetail.umaConfiguration.authorization_endpoint);
          }
          return reject(error);
        });
    }).asCallback(callback);
  };

  /**
   * To add new user.
   * @param {string} id - inum of the group
   * @param {object} userData - Object of user details
   * @param {requestCallback} [callback] - The callback that handles the response and Error.
   * @returns {requestCallback|Promise<object, error>} - callback or promise that returns user detail if resolved, or an Error if rejected.
   */
  module.editGroup = function editGroup(id, groupData, callback) {
    return new Promise(function (resolve, reject) {
      if (!id) {
        return reject(new Error('Provide valid value of id.'));
      }
      var groupEndpoint = '';
      return getSCIMConfigurations(params.domain)
        .then(function (scimConfig) {
          groupEndpoint = scimConfig.group_endpoint;
          return getRPTToken(params, groupEndpoint);
        })
        .then(function (rptDetail) {
          return update(groupEndpoint, rptDetail.RPT.access_token, groupData, 'urn:ietf:params:scim:schemas:core:2.0:Group', id)
        })
        .then(function (groups) {
          return resolve(groups);
        })
        .catch(function (error) {
          if (error.statusCode === 403) {
            // return authorizeRPT(rptDetail.RPT, rptDetail.AAT, error.error, rptDetail.umaConfiguration.authorization_endpoint);
          }
          return reject(error);
        });
    }).asCallback(callback);
  };

  /**
   * To remove user.
   * @param {string} id - inum of user
   * @param {requestCallback} [callback] - The callback that handles the response and Error.
   * @returns {requestCallback|Promise<object, error>} - callback or promise that returns empty data if resolved, or an Error if rejected.
   */
  module.removeGroup = function removeGroup(id, callback) {
    return new Promise(function (resolve, reject) {
      if (!id) {
        return reject(new Error('Provide valid value of id.'));
      }
      var groupEndpoint = '';
      return getSCIMConfigurations(params.domain)
        .then(function (scimConfig) {
          groupEndpoint = scimConfig.group_endpoint;
          return getRPTToken(params, groupEndpoint);
        })
        .then(function (rptDetail) {
          return _delete(groupEndpoint, rptDetail.RPT.access_token, id)
        })
        .then(function (groups) {
          return resolve(groups);
        })
        .catch(function (error) {
          if (error.statusCode === 403) {
            // return authorizeRPT(rptDetail.RPT, rptDetail.AAT, error.error, rptDetail.umaConfiguration.authorization_endpoint);
          }
          return reject(error);
        });
    }).asCallback(callback);
  };

  /**
   * To send search request.
   * @param {string} filter - Filter string
   * @param {int} startIndex - page index starts with 1.
   * @param {int} count - number of users to be returned.
   * @param {requestCallback} [callback] - The callback that handles the response and Error.
   * @returns {requestCallback|Promise<object, error>} - callback or promise that returns user detail if resolved, or an Error if rejected.
   */
  module.searchUsers = function searchUsers(filter, startIndex, count, callback) {
    return new Promise(function (resolve, reject) {
      var userEndpoint = '';
      return getSCIMConfigurations(params.domain)
        .then(function (scimConfig) {
          userEndpoint = scimConfig.user_endpoint;
          return getRPTToken(params, userEndpoint);
        })
        .then(function (rptDetail) {
          return search(userEndpoint, rptDetail.RPT.access_token, filter, startIndex, count, 'urn:ietf:params:scim:api:messages:2.0:SearchRequest')
        })
        .then(function (users) {
          return resolve(users);
        })
        .catch(function (error) {
          if (error.statusCode === 403) {
            // return authorizeRPT(rptDetail.RPT, rptDetail.AAT, error.error, rptDetail.umaConfiguration.authorization_endpoint);
          }
          return reject(error);
        });
    }).asCallback(callback);
  };

  return module;
};
