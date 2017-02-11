module.exports = function(app/*, options*/) {
  var bodyParser = require('body-parser');
  var mysql = require('mysql');
  var config = require('../../config/environment')().APP;
  var request = require('request');

  var helper = require('sendgrid').mail;
  var crypto = require('crypto');

  var rancherApiUrl = `${config.apiServer}${config.apiEndpoint}`;
  var tablePrefix = process.env.DB_TABLE_PREFIX || '';

  const ERRORS = {
    auth: {
      message: 'Unauthorized',
      status: 401,
      type: 'error',
      detail: 'Unauthorized'
    },
    account: {
      message: 'Unauthorized',
      status: 401,
      type: 'error',
      detail: 'There was an error trying to retrieve that account, ensure you have entered the correct credentials and try again later'
    },
    db: {
      message: 'Internal Server Error',
      status: 500,
      type: 'error',
      detail: 'There was an error retrieving your data, ensure the info you entered is correct and try again'
    },
    email: {
      message: 'Internal Server Error',
      status: 500,
      type: 'error',
      detail: 'There was an error with your email, ensure you have entered the correct email and try again'
    },
    generic: {
      message: 'Internal Server Error',
      status: 500,
      type: 'error',
      detail: 'Internal Server Error'
    },
    token: {
      message: 'Internal Server Error',
      status: 500,
      type: 'error',
      detail: 'There was an error trying to retrieve that token, try again later'
    },
  };

  app.use(bodyParser.json()); // for parsing application/json

  var pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  app.use('/register-new', function(req, res) {
    generateAndInsertToken(null, req.body.name, req.body.email, "create", function(err, token) {
      if (err) {
        return generateError('auth', err, res);
      }

      sendVerificationEmail(req.body.email, req.body.name, req.headers.origin, token, function(err) {
        if (err) {
          return generateError('email', err, res);
        }

        res.status(200).json();
      });
    });
  });


  app.use('/verify-token', function(req, res) {
    getChallengeToken(req.body.token, function(err, row) {
      if (err || !row) {
        return generateError('token', err, res);
      }

      var out = {
        email: row.email,
        name: row.name,
      };
      res.status(200).send(out);
    });
  });

  app.use('/create-user', function(req, res) {
    var user = req.body;

    var account = {
      type: 'user',
      name: user.name
    };

    var credential = {
      type: 'password',
      publicValue: user.email,
      secretValue: user.pw,
      accountId: null
    };

    getChallengeToken(user.token, function(err, row) {
      if (err || !row ) {
        return generateError('token', err, res);
      }

      newRequest({
        url: `${rancherApiUrl}/account`,
        method: 'POST',
        body: account
      }, function(accountModel) {
        credential.accountId = accountModel.id;

        newRequest({
          url: `${rancherApiUrl}/passwords`,
          method: 'POST',
          body: credential
        }, function(/*credentialModel*/) {
          removeUserFromTable(user.email, function(err) {
            if ( err ) {
              return generateError('db', err, res);
            }

            getTokenForLogin(user.email, user.pw, function(err, token, serverResponse) {
              if (err) {
                return res.status(serverResponse.status).send(token);
              }

              res.cookie('token', token.jwt, {secure: req.secure}).status(200).send({type: 'success'});
            });
          });
        }, res);
      }, res);
    });
  });

  app.use('/reset-password', function(req, res) {
    var user = req.body;
    var userEmail = user.email;
    var name = user.name;
    var url = `${rancherApiUrl}/credentials?kind=password&publicValue=${encodeURIComponent(userEmail)}&limit=1&sort=name`;

    if (!user.email) {
      return generateError('account', 'No email for account', res);
    }

    newRequest({
      url: url,
      method: 'GET',
    }, function(body) {
      if (!body || !body.data || !body.data.length ) {
        return generateError('account', 'No password found ', res);
      }

      var credential = body.data[0];
      var url = `${rancherApiUrl}/accounts/${encodeURIComponent(credential.accountId)}`;
      var credEmail = credential.publicValue;

      newRequest({
        url: url,
        method: 'GET'
      }, function(body) {
        if (body.type !== 'account') {
          return generateError('account', 'Body type is not account', res);
        }

        generateAndInsertToken(body.id, name, credEmail, "reset", function(err, token) {
          if (err) {
            return generateError('token', err, res);
          }

          sendPasswordReset(req.body.email, body.name, req.headers.origin, token, function(err) {
            if (err) {
              return generateError('email', err, res);
            }

            res.status(200).json({success: 'Email sent'});
          });
        });
      });
    });
  });

  app.use('/update-password', function(req, res) {
    var user = req.body;

    getChallengeToken(user.token, function(err, credential) {
      if (err || !credential || !credential.email) {
        return generateError('token', err, res);
      }

      newRequest({
        url: `${rancherApiUrl}/passwords?publicValue=${encodeURIComponent(credential.email)}`,
        method: 'GET'
      }, function(body) {

        if ( !body || !body.data || !body.data.length ) {
          return generateError('token', err, res);
        }

        newRequest({
          url: body.data[0].actions.changesecret,
          method: 'POST',
          body: {newSecret: user.pw, oldSecret: ''}
        }, function(/*body*/) {
          removeUserFromTable(credential.email, function(err) {
            if ( err ) {
              return generateError('db', err, res);
            }

            getTokenForLogin(credential.email, user.pw, function(err, body, serverResponse) {
              if (err) {
                return res.status(serverResponse.status).send(body);
              }

              sendPasswordVerificationEmail(credential.email, credential.name, req.headers.origin, function(err) {
                if (err) {
                  return generateError('email', err, res);
                }

                res.cookie('token', body.jwt, {secure: req.secure}).status(200).send({type: 'success'});
              });
            }, res);
          });
        }, res);
      });
    });
  });

  function generateAndInsertToken(id, name, email, request, cb) {
    var challengeToken = crypto.randomBytes(20);
    challengeToken = challengeToken.toString('hex');
    return pool.query(`INSERT INTO ${tablePrefix}challenge SET account_id = ?, name = ?, email = ?, token = ?, request = ?, created = NOW()`, [id, name, email, challengeToken, request], function(err) {
      cb(err, challengeToken);
    });
  }

  function getTokenForLogin(username, password, cb) {
    return request({
      method: 'POST',
      json: true,
      url: `${rancherApiUrl}/token`,
      body: {
        code: `${username}:${password}`
      }
    }, function(err, response, body) {
      if (err) {
        console.log('getTokenForLogin error: ', err);
      }

      if (response.statusCode >= 200 && response.statusCode < 300) {
        return cb(null, body, response);
      }

      var errOut = null;
      if (err) {
        errOut = err;
      } else {
        errOut = response;
      }

      // cattle error just pass it along
      cb(errOut, body, response);
    });
  }

  // opts should only contain url, method and data
  function newRequest(opts, cb, ogRes) {
    var optsOut = {
      auth: {
        user: process.env.CATTLE_ACCESS_KEY,
        pass: process.env.CATTLE_SECRET_KEY,
      },
      json: true,
    };

    Object.assign(optsOut, opts);

    return request(optsOut, function(err, response, body) {
      if (response.statusCode >= 200 && response.statusCode < 300) {
        return cb(body, response);
      }

      var errOut = null;
      if (err) {
        errOut = err;
      } else {
        errOut = response;
      }

      console.log('error:', errOut);
      if (ogRes) {
        generateError('account', err, ogRes);
      }
    });
  }

  function removeUserFromTable(email, cb) {
    return pool.query(`DELETE FROM ${tablePrefix}challenge WHERE email = ? OR created > DATE_SUB(NOW(), INTERVAL 24 HOUR)`, [email], function(err){
      if (err) {
        console.log('error', 'could not delete record:', email);
        return cb(err);
      }

      cb(null);
    });
  }

  function getChallengeToken(token, cb) {
    return pool.query(`SELECT * FROM ${tablePrefix}challenge WHERE token = ? AND created > DATE_SUB(NOW(), INTERVAL 24 HOUR)`, [token], function(err, results) {
      if (err) {
        console.log('error', 'could not retrieve token');
        return cb(err);
      }

      return cb(null, results[0]);
    });
  }

  function fetchSendGridApiDetails(detail, cb) {
    var base = `${rancherApiUrl}/settings`;

    return newRequest({
      url: `${base}/ui.sendgrid.api_key`,
      method: 'GET',
    }, function(body) {

      if (body) {
        var apiKey = body.activeValue;

        return newRequest({
          url: `${base}/${detail}`,
          method: 'GET'
        }, function(body) {

          if (body) {
            cb({apiKey: apiKey, id: body.value});
          } else {
            cb(false);
          }
        }, null);

      } else {

        cb(false);
      }
    });
  }

  function sendPasswordReset(email, name, host, token, cb) {
    fetchSendGridApiDetails('ui.sendgrid.template.password_reset', function(response) {
      if (response) {
        var from_email = new helper.Email('no-reply@rancher.com');
        var to_email = new helper.Email(email);
        var subject = 'Password Reset Request';
        var contentLink = `<html><a href="${host}/verify-reset-password/${token}">Reset Password</a></html>`;
        var content = new helper.Content(
          'text/html', contentLink);
        var mail = new helper.Mail(from_email, subject, to_email, content);
        mail.personalizations[0].addSubstitution(
          new helper.Substitution("-username-", name));
        mail.setTemplateId(response.id);

        var sg = require('sendgrid')(response.apiKey);
        var request = sg.emptyRequest({
          method: 'POST',
          path: '/v3/mail/send',
          body: mail.toJSON(),
        });

        return sg.API(request, cb);
      } else {
        cb('There was a problem retrieving the email api key or email template id.', null);
      }
    });
  }

  function sendVerificationEmail(email, name, host, token, cb) {
    fetchSendGridApiDetails('ui.sendgrid.template.create_user', function(response) {
      if (!response) {
        return cb('There was a problem retrieving the email api key or email template id.', null);
      }

      var from_email = new helper.Email('no-reply@rancher.com');
      var to_email = new helper.Email(email);
      var subject = 'Verify your Rancher Cloud Account';
      var contentLink = `<html><a href="${host}/verify/${token}">Verify Email</a></html>`;
      var content = new helper.Content(
        'text/html', contentLink);
      var mail = new helper.Mail(from_email, subject, to_email, content);
      mail.setTemplateId(response.id);

      var sg = require('sendgrid')(response.apiKey);
      var request = sg.emptyRequest({
        method: 'POST',
        path: '/v3/mail/send',
        body: mail.toJSON(),
      });

      return sg.API(request, cb);
    });
  }

  function sendPasswordVerificationEmail(email, name, host, cb) {
    fetchSendGridApiDetails('ui.sendgrid.template.verify_password', function(response) {
      if (!response) {
        return cb('There was a problem retrieving the email api key or email template id.', null);
      }

      var from_email = new helper.Email('no-reply@rancher.com');
      var to_email = new helper.Email(email);
      var subject = 'Password Reset Confirmation';
      var contentLink = `<html><a href="${host}/login?resetpw=true">Reset Password</a></html>`;
      var content = new helper.Content(
        'text/html', contentLink);
      var mail = new helper.Mail(from_email, subject, to_email, content);
      mail.setTemplateId(response.id);

      var sg = require('sendgrid')(response.apiKey);
      var request = sg.emptyRequest({
        method: 'POST',
        path: '/v3/mail/send',
        body: mail.toJSON(),
      });

      return sg.API(request, cb);
    });

  }

  function generateError(code, detail, response) {
    // eventually put real error log in this function
    console.log('Error Generator: ', detail);
    var err = ERRORS[code];
    return response.status(err.status).send(err);
  }
};
