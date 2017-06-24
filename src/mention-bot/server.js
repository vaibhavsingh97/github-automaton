var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

/**
 * Copyright (c) 2016-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * 
 */

var bl = require('bl');
var config = require('./config');
var express = require('express');
var fs = require('fs');
var mentionBot = require('./mention-bot.js');
var messageGenerator = require('./message.js');
var util = require('util');
var schedule = require('./schedule.js');

var GitHubApi = require('github');
var jsonlint = require('jsonlint');

var CONFIG_PATH = '.mention-bot';

if (!process.env.GITHUB_TOKEN) {
  console.error('The bot was started without a GitHub account to post with.');
  console.error('To get started:');
  console.error('1) Create a new account for the bot');
  console.error('2) Settings > Personal access tokens > Generate new token');
  console.error('3) Only check `public_repo` and click Generate token');
  console.error('4) Run the following command:');
  console.error('GITHUB_TOKEN=insert_token_here npm start');
  console.error('5) Run the following command in another tab:');
  console.error('curl -X POST -d @__tests__/data/23.webhook http://localhost:5000/');
  console.error('6) Check if it has commented here: https://github.com/fbsamples/bot-testing/pull/23');
  process.exit(1);
}

if (!process.env.GITHUB_USER) {
  console.warn('There was no GitHub user detected.', 'This is fine, but mention-bot won\'t work with private repos.');
  console.warn('To make mention-bot work with private repos, please expose', 'GITHUB_USER and GITHUB_PASSWORD as environment variables.', 'The username and password must have access to the private repo', 'you want to use.');
}

var github = new GitHubApi({
  host: config.github.apiHost,
  pathPrefix: config.github.pathPrefix,
  protocol: config.github.protocol,
  port: config.github.port
});

github.authenticate({
  type: 'oauth',
  token: process.env.GITHUB_TOKEN
});

var app = express();

function buildMentionSentence(reviewers) {
  var atReviewers = reviewers.map(function (owner) {
    return '@' + owner;
  });

  if (reviewers.length === 1) {
    return atReviewers[0];
  }

  return atReviewers.slice(0, atReviewers.length - 1).join(', ') + ' and ' + atReviewers[atReviewers.length - 1];
}

function defaultMessageGenerator(reviewers, pullRequester) {
  return util.format('%s, thanks for your PR! ' + 'By analyzing the history of the files in this pull request' + ', we identified %s to be%s potential reviewer%s.', pullRequester, buildMentionSentence(reviewers), reviewers.length > 1 ? '' : ' a', reviewers.length > 1 ? 's' : '');
}

function configMessageGenerator(message, reviewers, pullRequester) {
  var withReviewers = message.replace(/@reviewers/g, buildMentionSentence(reviewers));
  return withReviewers.replace(/@pullRequester/g, pullRequester);
}

function getRepoConfig(request) {
  return new Promise(function (resolve, reject) {
    github.repos.getContent(request, function (err, result) {
      if (err) {
        reject(err);
        return;
      }
      try {
        var data = JSON.parse(result.data);
        resolve(data);
      } catch (e) {
        try {
          e.repoConfig = result.data;
        } catch (e) {}
        reject(e);
      }
    });
  });
}

function work(body) {
  var data, repoConfig, configRes, isValid, org, reviewers, message, createComment, assignReviewer, requestReview, getComments, page, comments;
  return regeneratorRuntime.async(function work$(_context) {
    while (1) switch (_context.prev = _context.next) {
      case 0:
        getComments = function getComments(data, page) {
          return new Promise(function (resolve, reject) {
            github.issues.getComments({
              owner: data.repository.owner.login, // 'fbsamples'
              repo: data.repository.name, // 'bot-testing'
              number: data.pull_request.number, // 23
              page: page, // 1
              per_page: 100 // maximum supported
            }, function (err, result) {
              if (err) {
                reject(err);
              }
              resolve(result);
            });
          });
        };

        requestReview = function requestReview(data, reviewers, reject) {
          if (!repoConfig.createReviewRequest) {
            return;
          }

          github.pullRequests.createReviewRequest({
            owner: data.repository.owner.login, // 'fbsamples'
            repo: data.repository.name, // 'bot-testing'
            number: data.pull_request.number, // 23
            reviewers: reviewers
          }, function (err) {
            if (err) {
              if (typeof reject === 'function') {
                return reject(err);
              }
            }
          });
        };

        assignReviewer = function assignReviewer(data, reviewers, reject) {
          if (!repoConfig.assignToReviewer) {
            return;
          }

          github.issues.edit({
            owner: data.repository.owner.login, // 'fbsamples'
            repo: data.repository.name, // 'bot-testing'
            number: data.pull_request.number, // 23
            assignees: reviewers
          }, function (err) {
            if (err) {
              if (typeof reject === 'function') {
                return reject(err);
              }
            }
          });
        };

        createComment = function createComment(data, message, reject) {
          if (!repoConfig.createComment) {
            return;
          }

          github.issues.createComment({
            owner: data.repository.owner.login, // 'fbsamples'
            repo: data.repository.name, // 'bot-testing'
            number: data.pull_request.number, // 23
            body: message
          }, function (err) {
            if (err) {
              if (typeof reject === 'function') {
                return reject(err);
              }
            }
          });
        };

        isValid = function isValid(repoConfig, data) {
          if (repoConfig.branches && repoConfig.branches.length > 0 && repoConfig.branches.indexOf(data.pull_request.base.ref) === -1) {
            console.log('Skipping because base ref is "' + data.pull_request.base.ref + '".', 'We only care about: "' + repoConfig.branches.join("', '") + '"');
            return false;
          }

          if (repoConfig.actions.indexOf(data.action) === -1) {
            console.log('Skipping because action is "' + data.action + '".', 'We only care about: "' + repoConfig.actions.join("', '") + '"');
            return false;
          }

          if (repoConfig.withLabel && data.label && data.label.name != repoConfig.withLabel) {
            console.log('Skipping because pull request does not have label: "' + repoConfig.withLabel + '".');
            return false;
          }

          if (repoConfig.skipTitle && data.pull_request.title.indexOf(repoConfig.skipTitle) > -1) {
            console.log('Skipping because pull request title contains: "' + repoConfig.skipTitle + '".');
            return false;
          }

          if (repoConfig.skipCollaboratorPR) {
            github.repos.checkCollaborator({
              owner: data.repository.owner.login, // 'fbsamples'
              repo: data.repository.name, // 'bot-testing'
              username: data.pull_request.user.login
            }, function (err, res) {
              if (res && res.meta.status === '204 No Content') {
                console.log('Skipping because pull request is made by collaborator.');
                return false;
              }
            });
          }

          if (repoConfig.skipAlreadyAssignedPR && data.pull_request.assignee && data.pull_request.assignee.login) {
            console.log('Skipping because pull request is already assigned.');
            return false;
          }

          if (process.env.REQUIRED_ORG) {
            if (repoConfig.requiredOrgs.indexOf(process.env.REQUIRED_ORG) === -1) {
              repoConfig.requiredOrgs.push(process.env.REQUIRED_ORG);
            }
          }

          if (repoConfig.userBlacklistForPR.indexOf(data.pull_request.user.login) >= 0) {
            console.log('Skipping because blacklisted user created Pull Request.');
            return false;
          }

          if (repoConfig.skipTitle && data.pull_request.title.indexOf(repoConfig.skipTitle) > -1) {
            console.log('Skipping because pull request title contains: "' + repoConfig.skipTitle + '".');
            return false;
          }

          return true;
        };

        data = {};

        try {
          data = JSON.parse(body.toString());
          console.log(data.pull_request.html_url);
        } catch (e) {
          console.error(e);
        }

        // default config
        repoConfig = {
          maxReviewers: 3,
          numFilesToCheck: 5,
          userBlacklist: [],
          userBlacklistForPR: [],
          userWhitelist: [],
          fileBlacklist: [],
          requiredOrgs: [],
          findPotentialReviewers: true,
          actions: ['opened'],
          branches: [],
          skipAlreadyAssignedPR: false,
          skipAlreadyMentionedPR: false,
          delayed: false,
          delayedUntil: '3d',
          assignToReviewer: false,
          createReviewRequest: false,
          createComment: true,
          skipTitle: '',
          withLabel: '',
          skipCollaboratorPR: false
        };


        if (process.env.MENTION_BOT_CONFIG) {
          try {
            repoConfig = _extends({}, repoConfig, JSON.parse(process.env.MENTION_BOT_CONFIG));
          } catch (e) {
            console.error('Error attempting to read the config from the environment variable ' + ' MENTION_BOT_CONFIG');
            console.error(e);
          }
        }

        _context.prev = 9;
        _context.next = 12;
        return regeneratorRuntime.awrap(getRepoConfig({
          owner: data.repository.owner.login,
          repo: data.repository.name,
          ref: data.pull_request.base.ref,
          path: CONFIG_PATH,
          headers: {
            Accept: 'application/vnd.github.v3.raw+json'
          }
        }).catch(function (e) {
          if (e instanceof SyntaxError && repoConfig.actions.indexOf(data.action) !== -1) {
            // Syntax error while reading custom configuration file
            var errorLog = '';
            try {
              jsonlint.parse(e.repoConfig);
            } catch (err) {
              errorLog = err;
            }
            var message = 'Unable to parse mention-bot custom configuration file due to a syntax error.\n' + 'Please check the potential root causes below:\n\n' + '1. Having comments\n' + '2. Invalid JSON type\n' + '3. Having extra "," in the last JSON attribute\n\n' + 'Error message:\n' + '```\n' + errorLog + '\n```';
            createComment(data, message);
          }
        }));

      case 12:
        configRes = _context.sent;

        repoConfig = _extends({}, repoConfig, configRes);
        _context.next = 19;
        break;

      case 16:
        _context.prev = 16;
        _context.t0 = _context['catch'](9);

        if (_context.t0.code === 404 && _context.t0.message.match(/message.*Not Found.*documentation_url.*developer.github.com/)) {
          console.log('Couldn\'t find ' + CONFIG_PATH + ' in repo. Continuing with default configuration.');
        } else {
          console.error(_context.t0);
        }

      case 19:
        if (isValid(repoConfig, data)) {
          _context.next = 21;
          break;
        }

        return _context.abrupt('return');

      case 21:
        org = null;


        if (data.organization) {
          org = data.organization.login;
        }

        _context.next = 25;
        return regeneratorRuntime.awrap(mentionBot.guessOwnersForPullRequest(data.repository.html_url, // 'https://github.com/fbsamples/bot-testing'
        data.pull_request.number, // 23
        data.pull_request.user.login, // 'mention-bot'
        data.pull_request.base.ref, // 'master'
        data.repository.private, //true or false
        org, //the org name of the repo
        repoConfig, github));

      case 25:
        reviewers = _context.sent;


        console.log('Reviewers:', reviewers);

        if (!(reviewers.length === 0)) {
          _context.next = 30;
          break;
        }

        console.log('Skipping because there are no reviewers found.');
        return _context.abrupt('return');

      case 30:
        message = null;

        if (repoConfig.message) {
          message = configMessageGenerator(repoConfig.message, reviewers, '@' + data.pull_request.user.login);
        } else {
          message = messageGenerator(reviewers, '@' + data.pull_request.user.login, // pull-requester
          buildMentionSentence, defaultMessageGenerator);
        }

        if (!repoConfig.skipAlreadyMentionedPR) {
          _context.next = 45;
          break;
        }

        comments = [[]];
        page = 1;

      case 35:
        if (!(comments.length != 0)) {
          _context.next = 45;
          break;
        }

        _context.next = 38;
        return regeneratorRuntime.awrap(getComments(data, page));

      case 38:
        comments = _context.sent;

        if (!comments.find(function (comment) {
          return comment.body == message;
        })) {
          _context.next = 42;
          break;
        }

        console.log('Skipping because there is already existing an exact mention.');
        return _context.abrupt('return');

      case 42:
        ++page;
        _context.next = 35;
        break;

      case 45:

        if (repoConfig.delayed) {
          schedule.performAt(schedule.parse(repoConfig.delayedUntil), function (resolve, reject) {
            github.pullRequests.get({
              owner: data.repository.owner.login,
              repo: data.repository.name,
              number: data.pull_request.number
            }, function (err, currentData) {
              if (err) {
                reject(err);
                return;
              }

              if (!isValid(repoConfig, currentData)) {
                reject('PR validation failed');
                return;
              }

              createComment(currentData, message, reject);
              assignReviewer(currentData, reviewers, reject);
              requestReview(currentData, reviewers, reject);
            });
          });
        } else {
          createComment(data, message);
          assignReviewer(data, reviewers);
          requestReview(data, reviewers);
        }

        return _context.abrupt('return');

      case 47:
      case 'end':
        return _context.stop();
    }
  }, null, this, [[9, 16]]);
};

app.post('/', function (req, res) {
  req.pipe(bl(function (err, body) {
    work(body).then(function () {
      res.end();
    }).catch(function (e) {
      console.error(e);
      console.error(e.stack);
      res.status(500).send('Internal Server Error');
    });
  }));
});

app.get('/', function (req, res) {
  res.send('GitHub Mention Bot Active. ' + 'Go to https://github.com/facebook/mention-bot for more information.');
});

app.set('port', process.env.PORT || 5000);

app.listen(app.get('port'), function () {
  console.log('Listening on port', app.get('port'));
});