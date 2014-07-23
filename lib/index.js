// Copyright (c) 2014, Joyent, Inc. All rights reserved.

var EventEmitter = require('events').EventEmitter;

var assert = require('assert-plus');

var health = require('./health');
var register = require('./register');
var zk = require('./zk');



///--- Helpers

function _export(obj) {
    Object.keys(obj).forEach(function (k) {
        module.exports[k] = obj[k];
    });
}



///--- API

function register_plus(opts) {
    assert.object(opts, 'options');
    assert.object(opts.log, 'options.log');
    assert.object(opts.zk, 'options.zk');

    var check;
    var ee = new EventEmitter();
    var log = opts.log.child({component: 'registrar'}, true);
    var stop = false;
    var zk_timer;
    var zk = opts.zk;
    var znodes;

    register.register(opts, function (err, _znodes) {
        if (err) {
            log.debug(err, 'registration(%j): failed', opts.registration);
            ee.emit('error', err);
            return;
        }

        znodes = _znodes;

        function healthcheck() {
            check = health.createHealthCheck(opts.healthCheck);
            var down = false;

            check.on('data', function (obj) {
                switch (obj.type) {
                case 'ok':
                    if (down) {
                        ee.emit('ok');

                        register.register(opts, function (r_err, __znodes) {
                            if (r_err) {
                                log.debug(r_err, 'register: reregister failed');
                                ee.emit('error', r_err);
                            } else {
                                znodes = __znodes;
                                ee.emit('register', __znodes);
                                setImmediate(function () {
                                    down = false;
                                });
                            }
                        });
                    }
                    break;

                case 'fail':
                    if (obj.err && obj.isDown && !down) {
                        down = true;
                        var e = obj.err;
                        delete obj.err;
                        log.debug(e, {
                            check: obj,
                            znodes: znodes
                        }, 'healthcheck failed, deregistering')

                        ee.emit('fail', e);

                        var u_opts = {
                            log: log,
                            zk: zk,
                            znodes: znodes
                        };
                        register.unregister(u_opts, function (u_err) {
                            if (u_err) {
                                log.debug(u_err, 'healthcheck: unregister failed');
                                ee.emit('error', u_err);
                            } else {
                                ee.emit('unregister', e, znodes);
                            }
                        });
                    }
                    break;

                default:
                    log.debug({
                        check: obj
                    }, 'healtcheck: unknown type encountered');
                    ee.emit('error',
                            new Error('unknown check type: ' + obj.type));
                    break;
                }
            });

            check.on('error', function (err) {
                log.debug(err, 'healtcheck: unexpected error');
                ee.emit('error', err);
            });

            check.on('end', function () {
                log.debug('healthcheck: done');
            });

            if (!stop)
                check.start();
        }

        (function zkHeartbeat() {
            var heartbeatInterval = opts.heartbeatInterval || 3000;
            var hCfg = opts.heartbeat || {};

            (function checkZK() {
                log.debug('zk.heartbeat(%j): starting', znodes);
                zk.heartbeat({nodes: znodes}, function (check_err) {
                    var _data;
                    var _event;
                    var _to;

                    if (check_err) {
                        log.debug(check_err, 'zk.heartbeat(%j) failed', znodes);
                        _data = check_err;
                        _event = 'heartbeatFailure';
                        _to = Math.max(heartbeatInterval, 60000);
                    } else {
                        log.debug('zk.heartbeat(%j): ok', znodes);
                        _data = znodes;
                        _event = 'heartbeat';
                        _to = heartbeatInterval;
                    }

                    if (!stop)
                        zk_timer = setTimeout(checkZK, _to);
                    ee.emit(_event, _data);
                });
            })();
        })();

        if (opts.healthCheck)
            healthcheck();

        ee.stop = function () {
            stop = true;

            if (check)
                check.stop();

            clearTimeout(zk_timer);
        };

        ee.emit('register', znodes);
    });

    return (ee);
}


///--- Exports

module.exports = register_plus;

_export(health);
_export(register);
_export(zk);
