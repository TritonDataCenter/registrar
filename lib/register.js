/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var os = require('os');
var path = require('path');

var assert = require('assert-plus');
var once = require('once');
var vasync = require('vasync');



///--- Helpers

function address() {
    var ifaces = os.networkInterfaces();
    var addrs = Object.keys(ifaces).filter(function (k) {
        return (!ifaces[k][0].internal);
    }).map(function (k) {
        return (ifaces[k][0]);
    });

    return (addrs[0].address);
}


function domainToPath(domain) {
    assert.string(domain, 'domain');

    // 1.moray.us-east.joyent.com) => /com/joyent/us-east/moray/1
    return ('/' + domain.split('.').reverse().join('/'));
}



///--- API

function registerService(opts, cb) {
    if (!opts.registration.service) {
        cb();
        return;
    }

    cb = once(cb);

    var log = opts.log;
    var zk = opts.zk;

    log.debug('registerService(%s): entered', opts.path);

    var obj = {
        type: 'service',
        service: opts.registration.service
    };
    opts.zk.put(opts.path, obj, function (err) {
        if (err) {
            log.error(err, 'registerService: put failed');
            cb(err);
        } else {
            log.debug('registerService: done');

            if (opts.nodes.indexOf(opts.path) === -1)
                opts.nodes.push(opts.path);

            cb();
        }
    });
}


function cleanupPreviousEntries(opts, cb) {
    cb = once(cb);

    var log = opts.log;
    var zk = opts.zk;

    log.debug('cleanupPreviousEntries(%j): entered', opts.nodes);
    vasync.forEachParallel({
        func: function _unlink(n, _cb) {
            zk.unlink(n, function (err) {
                if (err && err.name !== 'NO_NODE') {
                    _cb(err);
                } else {
                    _cb();
                }
            });
        },
        inputs: opts.nodes
    }, function (err) {
        if (err) {
            log.debug(err, 'cleanupPreviousEntries: failed');
            cb(err);
        } else {
            log.debug(err, 'cleanupPreviousEntries: done');
            cb();
        }
    });
}


function setupDirectories(opts, cb) {
    cb = once(cb);

    var log = opts.log;
    var zk = opts.zk;

    log.debug('setupDirectories(%j): entered', opts.nodes);
    vasync.forEachParallel({
        func: zk.mkdirp.bind(zk),
        inputs: opts.nodes.map(function (p) {
            return (path.dirname(p));
        })
    }, function (err) {
        if (err) {
            log.debug(err, 'setupDirectories: failed');
            cb(err);
        } else {
            log.debug(err, 'setupDirectories: done');
            cb();
        }
    });
}


function registerEntries(opts, cb) {
    cb = once(cb);

    var log = opts.log;
    var zk = opts.zk;

    log.debug('registerEntries(%j): entered', opts.nodes);
    vasync.forEachParallel({
        func: function newEphmeral(n, _cb) {
            var _obj = {
                type: opts.registration.type,
                address: opts.adminIp ? opts.adminIp : address(),
                ttl: opts.registration.ttl
            };
            _obj[opts.registration.type] = {
                address: opts.adminIp ? opts.adminIp : address()
            };
            var _opts = {
                flags: ['ephemeral_plus']
            };
            zk.create(n, _obj, _opts, once(_cb));
        },
        inputs: opts.nodes
    }, function (err) {
        if (err) {
            log.debug(err, 'registerEntries: failed');
            cb(err);
        } else {
            log.debug(err, 'registerEntries: done');
            cb();
        }
    });
}


function register(opts, cb) {
    assert.object(opts, 'options');
    assert.object(opts.log, 'options.log');
    assert.optionalString(opts.adminIp, 'options.adminIp');
    assert.optionalObject(opts.aliases, 'options.aliases');
    assert.string(opts.domain, 'options.domain');
    assert.object(opts.registration, 'options.registration');
    assert.string(opts.registration.type, 'options.registration.type');
    assert.optionalNumber(opts.registration.ttl, 'options.registration.ttl');
    assert.optionalObject(opts.registration.service,
                          'options.registration.service');
    if (opts.registration.service) {
        var s = opts.registration.service;
        assert.string(s.type, 'options.registration.service.type');
        assert.ok(s.type === 'service');
        assert.object(s.service, 'options.registration.service.service');
        var s2 = s.service;
        assert.string(s2.srvce, 'options.registration.service.service.srvce');
        assert.string(s2.proto, 'options.registration.service.service.proto');
        assert.optionalNumber(s2.ttl,
                              'options.registration.service.service.ttl');
        s2.ttl = s2.ttl !== undefined ? s2.ttl : 60;
        assert.number(s2.port, 'options.registration.service.service.port');
    }
    assert.object(opts.zk, 'options.zk');
    assert.func(cb, 'callback');

    cb = once(cb);

    var p = domainToPath(opts.domain);
    var log = opts.log.child({
        component: 'register',
        aliases: opts.aliases,
        domain: opts.domain,
        path: p,
        registration: opts.registration
    }, true);

    log.debug('register: entered');

    // Register $self in ZK depending on the type.
    var cookie = {
        adminIp: opts.adminIp || null,
        domain: opts.domain,
        log: log,
        nodes: [
            path.join(p, os.hostname())
        ].concat((opts.aliases || []).map(domainToPath)),
        path: p,
        registration: opts.registration,
        zk: opts.zk
    };
    vasync.pipeline({
        arg: cookie,
        funcs: [
            cleanupPreviousEntries,
            function wait(_, _cb) {
                // Be nice to watchers and wait for them to catch up
                setTimeout(once(_cb), 1000);
            },
            setupDirectories,
            registerEntries,
            registerService
        ]
    }, function (err) {
        if (err) {
            log.debug(err, 'register: unable to register with ZooKeeper');
            cb(err);
        } else {
            log.debug({
                znodes: cookie.nodes
            }, 'register: done');
            cb(null, cookie.nodes);
        }
    });
}


function unregister(opts, cb) {
    assert.object(opts, 'options');
    assert.object(opts.log, 'options.log');
    assert.object(opts.zk, 'options.zk');
    assert.arrayOfString(opts.znodes, 'options.znodes');
    assert.func(cb, 'callback');

    cb = once(cb);

    var log = opts.log.child({
        component: 'unregister',
        znodes: opts.znodes
    }, true);
    var zk = opts.zk;

    log.debug('unregister: entered');
    vasync.forEachPipeline({
        func: function cleanup(n, _cb) {
            _cb = once(_cb);

            log.debug('unregister: deleting %s', n);
            zk.unlink(n, function (err) {
                if (err) {
                    log.debug(err, 'unregister: failed to delete %s', n);
                    _cb(err);
                } else {
                    log.debug('unregister: unlink(%s) done', n);
                    cb();
                }
            });
        },
        inputs: opts.znodes
    }, function (err) {
        if (err) {
            log.debug(err, 'unregister: failed');
            cb(err);
        } else {
            log.debug('unregister: done');
            cb();
        }
    });
}



///--- Exports

module.exports = {
    register: register,
    unregister: unregister
};
