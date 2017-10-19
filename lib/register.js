/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var os = require('os');
var path = require('path');

var assert = require('assert-plus');
var once = require('once');
var util = require('util');
var vasync = require('vasync');
var verror = require('verror');

var VError = verror.VError;


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
    return ('/' + domain.toLowerCase().split('.').reverse().join('/'));
}



///--- API

function registerService(opts, cb) {
    if (!opts.registration.service) {
        cb();
        return;
    }

    cb = once(cb);

    var log = opts.log;
    var registrar = opts.registrar;
    var zk = opts.zk;

    log.debug('registerService(%s): entered', opts.path);

    var data = new Buffer(JSON.stringify({
        type: 'service',
        service: opts.registration.service
    }), 'utf8');

    vasync.waterfall([
        function (callback) {
            zk.get(opts.path, function (err, recvData) {
                if (err) {
                    /*
                     * We do not expect the service node to disappear in the
                     * event that we have to re-establish a session. This
                     * indicates unexpected interference.
                     */
                    if (err.code === 'NO_NODE') {
                        if (registrar.getSessionGeneration() > 0) {
                            log.warn(err, 'missing service node ' + opts.path +
                                ' on subsequent session');
                        }
                        callback(null, false);
                        return;
                    }
                    callback(err);
                    return;

                }
                callback(null, true, recvData);
            });
        },
        function (found, recvData, callback) {
            if (recvData instanceof Function) {
                callback = recvData;
                recvData = null;
            }

            /*
             * Create the service node if it was not found. Set its data
             * appropriately if it was found, but the data buffer did not match
             * what was expected. Otherwise, just continue.
             */
            if (!found) {
                zk.createWithEmptyParents(opts.path, data, {}, function (err) {
                    if (err && err.code == 'NODE_EXISTS') {
                        callback();
                        return;
                    }
                    callback(err);
                });

            } else if (recvData !== null && data.compare(recvData) !== 0) {
                zk.set(opts.path, data, -1, callback);

            } else {
                callback();
            }
        }
    ], function(err) {
        if (err) {
            log.error(err, 'registerService: failed');
        } else {
            log.debug('registerService: done');
        }
        cb(err);
    });
}


function cleanupPreviousEntries(opts, cb) {
    cb = once(cb);

    var log = opts.log;
    var zk = opts.zk;

    log.debug('cleanupPreviousEntries(%j): entered', opts.nodes);
    vasync.forEachParallel({
        func: function _delete(n, _cb) {
            if (opts.registrar.ephemerals[n])
                delete opts.registrar.ephemerals[n];

            var ver = opts.version !== undefined ? opts.version : -1;
            zk.delete(n, ver, function (err) {
                if (err && err.code !== 'NO_NODE') {
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


function registerEntries(opts, cb) {
    cb = once(cb);

    var log = opts.log;
    var zk = opts.zk;
    var registrar = opts.registrar;

    log.debug('registerEntries(%j): entered', opts.nodes);
    vasync.forEachParallel({
        func: function newEphemeral(n, _cb) {
            var _obj = {
                type: opts.registration.type,
                address: opts.adminIp ? opts.adminIp : address(),
                ttl: opts.registration.ttl
            };
            var ports;
            if (opts.registration.ports) {
                ports = opts.registration.ports;
            } else if (opts.registration.service) {
                ports = [opts.registration.service.service.port];
            }
            _obj[opts.registration.type] = {
                address: opts.adminIp ? opts.adminIp : address(),
                ports: ports
            };
            var _opts = {
                flags: ['EPHEMERAL']
            };
            var data = new Buffer(JSON.stringify(_obj), 'utf8');

            zk.createWithEmptyParents(n, data, _opts, function (err) {
                var nodeExists = (err && err.code == 'NODE_EXISTS');
                if (!err || nodeExists) {
                    if (nodeExists) {
                        log.warn({
                            path: n
                        }, 'registerEntries: trying to create node that ' +
                           'that already exists. Setting watcher to ' +
                           're-create it if it drops out.');
                    }
                    registrar.ephemerals[n] = {
                        data: data,
                        opts: _opts,
                        path: n,
                        retrying: false
                    };
                    setImmediate(_cb);
                } else {
                    setImmediate(_cb, err);
                }
            });
        },
        inputs: opts.nodes
    }, function (err) {
        /*
         * We've already caught errors related to nodes existing when we're
         * trying to create them above, so if we received an error here, it's
         * something more fatal than needs to be retried.
         */
        if (err) {
            log.debug(err, 'registerEntries: failed');
            setImmediate(cb, err);
            return;
        }
        var watcher = zk.watcher(opts.path);
        registrar.watcher = watcher;

        /*
         * Note: a watcher for 'childrenChanged' will always fire once when the
         * listener is installed.
         */
        watcher.on('childrenChanged', function (changed) {
            /*
             * These are the ephemeral nodes that should be created.
             */
            var ephemerals = Object.keys(registrar.ephemerals);

            /*
             * These are the ephemeral nodes that currently exist.
             */
            var children = changed.map(function (child) {
                return (path.join(opts.path, child));
            });

            /*
             *
             * Returns a subset of ephemeral nodes this registrar is responsible
             * for create that:
             *  1. Are not currently present in zookeeper.
             *  2. We are not already trying to re-create.
             */
            var missing = ephemerals.filter(function (node) {
                if (children.indexOf(node) !== -1) {
                    return false;
                }
                var alreadyRetrying = registrar.ephemerals[node].retrying;
                if (!alreadyRetrying) {
                    registrar.ephemerals[node].retrying = true;
                }
                return (!alreadyRetrying);
            });

            log.debug({
                parent: opts.path,
                desired: util.inspect(ephemerals),
                present: util.inspect(children),
                missing: util.inspect(missing)
            }, 'registerEntries: watcher \'childrenChanged\' event. ' +
               'Recreating missing entries (if any).');

            missing.forEach(function (node) {
                var args = registrar.ephemerals[node];

                zk.createWithEmptyParents(args.path, args.data, args.opts,
                    function (createError) {
                    if (createError && createError.code !== 'NODE_EXISTS') {
                        log.debug({
                            err: createError,
                            path: args.path
                        }, 'registerEntries: failed while recreating ' +
                           'ephemeral node.');
                    } else {
                        log.debug({
                            path: node
                        }, 'registerEntries: recreated ephemeral node');
                        registrar.ephemerals[node].retrying = false;
                    }
                });
            });
        });
        log.debug('registerEntries: done');
        setImmediate(cb);
    });
}


function register(opts, registrar, cb) {
    assert.object(opts, 'options');
    assert.object(opts.log, 'options.log');
    assert.optionalString(opts.adminIp, 'options.adminIp');
    assert.optionalObject(opts.aliases, 'options.aliases');
    assert.string(opts.domain, 'options.domain');
    assert.object(opts.registration, 'options.registration');
    assert.string(opts.registration.type, 'options.registration.type');
    assert.object(registrar, 'registrar');
    assert.optionalNumber(opts.registration.ttl, 'options.registration.ttl');
    assert.optionalArrayOfNumber(opts.registration.ports,
                                 'options.registration.ports');
    assert.optionalObject(opts.registration.service,
                          'options.registration.service');
    assert.optionalBool(opts.firstRegistration, 'opts.firstRegistration');
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
        registrar: registrar,
        zk: opts.zk,
    };
    var pipeline = [
        registerService,
        registerEntries
    ];

    vasync.pipeline({
        arg: cookie,
        funcs: pipeline
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


function unregister(opts, registrar, cb) {
    assert.object(opts, 'options');
    assert.object(opts.log, 'options.log');
    assert.object(opts.zk, 'options.zk');
    assert.object(registrar, 'registrar');
    assert.func(cb, 'callback');

    cb = once(cb);

    var log = opts.log.child({
        component: 'unregister',
    }, true);
    var zk = opts.zk;

    log.debug('unregister: entered');

    zk.on('close', function () {
        registrar.zk = null;
        registrar.ephemerals = {};
        registrar.watcher = null;
        log.debug('unregister: done');
        cb();
    });

    zk.close();
}



///--- Exports

module.exports = {
    register: register,
    unregister: unregister
};
