// Copyright 2014 Joyent, Inc. All rights reserved.

var net = require('net');
var os = require('os');
var path = require('path');

var test = require('tape');
var uuid = require('node-uuid');
var vasync = require('vasync');

var helper = require('./helper');
var registrar = require('../lib');



///--- Helpers

function register(cfg, t, cb, callback) {
    registrar.register(cfg, function (err, znodes) {
        t.ifError(err);
        t.ok(znodes);
        t.ok(Array.isArray(znodes));
        t.ok(znodes.length);
        znodes.forEach(function (z) {
            t.equal('string', typeof (z));
        });

        vasync.forEachParallel({
            func: function (n, _cb) {
                helper.zkClient.stat(n, function (err2, stat) {
                    t.ifError(err2);
                    t.ok(stat);
                    if (new RegExp(os.hostname()).test(n))
                        t.ok((stat || {}).ephemeralOwner);
                    helper.zkClient.get(n, function (err3, obj) {
                        t.ifError(err3);
                        t.ok(obj);
                        if (err3 || !obj) {
                            _cb(err3);
                            return;
                        }
                        if (cb)
                            cb(n, obj);
                        _cb();
                    });
                });
            },
            inputs: znodes
        }, function (err2) {
            t.ifError(err2);
            if (callback && !err2) {
                callback(znodes);
            } else {
                t.end();
            }
        });
    });
}


///--- Tests

test('setup', function (t) {
    helper.createZkClient(t);
});


test('register: host only', function (t) {
    var cfg = {
        domain: 'test.laptop.joyent.us',
        log: helper.log,
        registration: {
            type: 'host',
        },
        zk: helper.zkClient
    };
    register(cfg, t);
});


test('unregister', function (t) {
    var cfg = {
        domain: 'test.laptop.joyent.us',
        log: helper.log,
        registration: {
            type: 'host',
        },
        zk: helper.zkClient
    };
    register(cfg, t, function _() {}, function (znodes) {
        var _opts = {
            log: helper.log,
            zk: helper.zkClient,
            znodes: znodes
        };
        registrar.unregister(_opts, function (err) {
            t.ifError(err);
            t.end();
        });
    });
});


test('register: host only with adminIP', function (t) {
    var cfg = {
        adminIp: '127.0.0.1',
        domain: 'test.laptop.joyent.us',
        log: helper.log,
        registration: {
            type: 'host',
        },
        zk: helper.zkClient
    };
    register(cfg, t, function (n, obj) {
        t.deepEqual({
            type: 'host',
            address: '127.0.0.1'
        }, obj);
    });
});


test('register: host only with adminIP+ttl', function (t) {
    var cfg = {
        adminIp: '127.0.0.1',
        domain: 'test.laptop.joyent.us',
        log: helper.log,
        registration: {
            type: 'host',
            ttl: 120
        },
        zk: helper.zkClient
    };
    register(cfg, t, function (n, obj) {
        t.deepEqual({
            type: 'host',
            address: '127.0.0.1',
            ttl: 120
        }, obj);
    });
});


test('register: basic with service', function (t) {
    var cfg = {
        domain: 'test.laptop.joyent.us',
        log: helper.log,
        registration: {
            type: 'host',
            ttl: 120,
            service: {
                type: 'service',
                service: {
                    srvce: '_http',
                    proto: '_tcp',
                    ttl: 60,
                    port: 80
                }
            }
        },
        zk: helper.zkClient
    };
    register(cfg, t, function (n, obj) {
        if (!new RegExp(os.hostname()).test(n)) {
            var _obj = {
                type: 'service',
                service: cfg.registration.service
            };
            t.deepEqual(_obj, obj);
        }
    });
});


test('register_plus: basic with service', function (t) {
    var cfg = {
        domain: 'test.laptop.joyent.us',
        log: helper.log,
        registration: {
            type: 'host',
            ttl: 120,
            service: {
                type: 'service',
                service: {
                    srvce: '_http',
                    proto: '_tcp',
                    ttl: 60,
                    port: 80
                }
            }
        },
        zk: helper.zkClient
    };
    var eventStream = registrar(cfg);

    eventStream.once('register', function () {
        eventStream.stop();
        t.end();
    });
});


test('teardown', function (t) {
    helper.zkClient.close(function (err) {
        t.ifError(err);
        t.end();
    });
});
