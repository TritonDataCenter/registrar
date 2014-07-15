// Copyright (c) 2014, Joyent, Inc. All rights reserved.

var exec = require('child_process').exec;
var stream = require('stream');

var assert = require('assert-plus');
var vasync = require('vasync');
var verror = require('verror');



///-- API

function createHealthCheck(options) {
    assert.object(options, 'options');
    assert.string(options.command, 'options.command');
    assert.optionalBool(options.ignoreExitStatus, 'options.ignoreExitStatus');
    assert.optionalNumber(options.interval, 'options.interval');
    assert.object(options.log, 'options.log');
    assert.optionalObject(options.stdoutMatch, 'options.stdoutMatch');
    options.stdoutMatch = options.stdoutMatch || {};
    assert.optionalString(options.stdoutMatch.flags,
                          'options.stdoutMatch.flags');
    assert.optionalBool(options.stdoutMatch.invert,
                        'options.stdoutMatch.invert');
    assert.optionalString(options.stdoutMatch.pattern,
                          'options.stdoutMatch.pattern');
    assert.optionalNumber(options.period, 'options.period');
    assert.optionalNumber(options.threshold, 'options.threshold');
    assert.optionalNumber(options.timeout, 'options.timeout');

    var command = options.command;
    var down = false;
    var fails = [];
    var interval = options.interval || 60000;
    var log = options.log.child({component: 'HealthCheck'}, true);
    var opts = {
        cwd: null,
        env: null,
        encoding: 'utf8',
        killSignal: 'SIGTERM',
        maxBuffer: 1024 * 1024,
        timeout: options.timeout || 1000
    };
    var output = new stream.PassThrough({
        objectMode: true
    });
    var period = options.period || 300 * 1000;
    var timer;
    var threshold = options.threshold || 5;

    function _period() {
        timer = setTimeout(function () {
            fails.length = 0;
        }, period);
    }

    function markDown(err) {
        log.debug(err, 'check: %s failed', command);
        if (!down) {
            fails.push(new verror.WError(err, command + ' failed'));

            if (fails.length === threshold) {
                down = true;
                err = new verror.MultiError(fails);
            }
        }

        output.write({
            type: 'fail',
            command: options.command,
            err: err,
            failures: fails.length,
            isDown: down,
            threshold: threshold,
        });
    }

    function check() {
        log.debug('check: running %s', command);

        exec(command, opts, function (err, stdout, stderr) {
            var ok = true;
            if (err && !options.ignoreExitStatus) {
                log.debug(err, 'check: %s failed', command);
                ok = false;
                markDown(err);
            } else if (options.stdoutMatch && options.stdoutMatch.pattern) {
                log.debug('check: matching stdout %s against %s',
                          options.stdoutMatch.pattern, stdout);
                var re = new RegExp(options.stdoutMatch.pattern,
                                    options.stdoutMatch.flags);

                if (!re.test(stdout)) {
                    var re_err = new Error('stdout match (' +
                                           options.stdoutMatch.pattern +
                                           ') failed');
                    log.debug(re_err, 'check: %s failed (stdout)',
                              options.stdoutMatch.pattern, stdout);
                    re_err.code = -1;
                    ok = false;
                    markDown(re_err);
                }
            }

            if (ok) {
                log.debug('healthCheck: %s ok', command);

                output.write({
                    type: 'ok',
                    command: options.command,
                });
            }

            if (output._running)
                output._timer = setTimeout(check, interval);
        });
    }

    output.start = function () {
        setImmediate(function () {
            timer = setTimeout(_period, period);
            if (!output._running) {
                output._running = true;
                check();
            }
        });
    };

    output.stop = function () {
        output._running = false;
        clearTimeout(output._timer);
        clearTimeout(timer);
        setImmediate(function () {
            output.end();
        });
    };

    return (output);
}



///-- Exports

module.exports = {
    createHealthCheck: createHealthCheck
};
