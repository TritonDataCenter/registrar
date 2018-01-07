/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var EventEmitter = require('events').EventEmitter;

var assert = require('assert-plus');
var zkstream = require('zkstream');

var health = require('./health');
var register = require('./register');



///--- Helpers

function _export(obj) {
    Object.keys(obj).forEach(function (k) {
        module.exports[k] = obj[k];
    });
}



///--- API

function createZKClient(opts, cb) {
    assert.object(opts, 'options');
    assert.object(opts.log, 'options.log');
    assert.arrayOfObject(opts.servers, 'options.servers');
    assert.func(cb, 'callback');

    assert.ok((opts.servers.length > 0), 'options.servers empty');

    opts.servers.forEach(function (s) {
        assert.string(s.address, 'servers.address');
        assert.number(s.port, 'servers.port');
    });

    cb(new zkstream.Client(opts));
}


function Registrar(opts) {
    assert.object(opts, 'options');
    assert.object(opts.log, 'options.log');
    assert.object(opts.zk, 'options.zk');

    this.options = opts;
    this.zk = opts.zk;
    this.ephemerals = {};
    this.check = null;
    this.sessionGeneration = 0;
}

Registrar.prototype.registerOnNewSession = function (callback) {
    var self = this;
    var opts = self.options;
    var log = self.log;

    function registerCallback(err, znodes) {
        if (!err) {
            self.sessionGeneration++;
        }
        callback(err);
    }

    /*
     * Final argument indicate that we are registering nodes as part of a new
     * session, and not as part of recovery from health check failure.
     */
    register.register(opts, this, registerCallback, true);
}

Registrar.prototype.getSessionGeneration = function () {
    return (this.sessionGeneration);
};

Registrar.prototype.hasHealthCheck = function () {
    return (this.check !== null);
}

Registrar.prototype.createHealthCheck = function () {
    var opts = this.options;
    var check;
    var ee = new EventEmitter();
    var log = opts.log.child({component: 'registrar'}, true);
    var stop = false;
    var zk = opts.zk;
    var znodes;

    var self = this;

    function healthcheck() {
        check = health.createHealthCheck(opts.healthCheck);
        self.check = check;
        var down = false;

        check.on('data', function (obj) {
            switch (obj.type) {
            case 'ok':
                if (down) {
                    ee.emit('ok');

                    register.register(opts, self, function (r_err, __znodes) {
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
                    }, 'healthcheck failed, unregistering')

                    ee.emit('fail', e);

                    var u_opts = {
                        log: log,
                        zk: zk,
                    };
                    register.unregister(u_opts, self, function (u_err) {
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

    if (opts.healthCheck)
        healthcheck();

    ee.stop = function () {
        stop = true;

        if (check)
            check.stop();
        self.check = null;
    };

    return (ee);
}

///--- Exports

module.exports = {
    createRegistrar: function (opts) {
        return (new Registrar(opts));
    },
    createZKClient: createZKClient
};

_export(health);
_export(register);
