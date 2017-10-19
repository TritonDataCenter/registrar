<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2017, Joyent, Inc.
-->

# Registrar

This repository is part of the Joyent Manta and Triton projects. For
contribution guidelines, issues, and general documentation, visit the main
[Triton](http://github.com/joyent/triton) and
[Manta](http://github.com/joyent/manta) project pages.

## Table of Contents:

* [Service discovery in Triton and Manta](#service-discovery-in-triton-and-manta)
* [Operating Registrar](#operating-registrar)
* [Developing with Registrar](#developing-with-registrar) (includes
  configuration reference)
* [ZooKeeper data format](#zookeeper-data-format)
* [Debugging Notes](#debugging-notes)


## Service discovery in Triton and Manta

Triton and Manta components generally discover their dependencies through DNS.
There are three main components that make up this service discovery system:

- a ZooKeeper cluster, which keeps track of the list of instances of each
  different type of component
- Registrar (this component), a small agent that runs alongside most Triton and
  Manta components to register that component's presence in ZooKeeper
- [Binder](https://github.com/joyent/binder), a server that answers DNS queries
  using the ZooKeeper state as the backing store

Let's examine what happens when an operator deploys a new instance of the Manta
service called "authcache".  We'll assume the deployment uses DNS suffix
"emy-10.joyent.us":

1. The operator provisions a new instance of "authcache".  This creates a new
   SmartOS zone (container).  The new container gets a uuid.  In this example,
   the uuid is "a2674d3b-a9c4-46bc-a835-b6ce21d522c2".
2. When the new zone boots up, various operating system services start up,
   including Registrar (this component).
3. Registrar reads its configuration file, which specifies that it should
   register itself at "authcache.emy-10.joyent.us".
4. Registrar connects to the ZooKeeper cluster and inserts a ZooKeeper [ephemeral
   node](https://zookeeper.apache.org/doc/r3.4.3/zookeeperProgrammers.html#Ephemeral+Nodes)
   called "/us/joyent/emy-10/authcache/a2674d3b-a9c4-46bc-a835-b6ce21d522c2".
   The contents of this node are a JSON payload that includes the IP address of
   this zone, as well as the ports it's listening on.  The ZooKeeper protocol
   requires that Registrar periodically heartbeat to the cluster in order to
   maintain its session and keep this ephemeral node alive.
5. Some time later, a client of authcache does a DNS query for
   "authcache.emy-10.joyent.us" using its configured nameservers, which are
   running instances of Binder.  Assuming Binder doesn't have the answer to
   this query cached, it fetches the state out of ZooKeeper under
   "/us/joyent/emy-10/authcache".  From this, it finds the IP addresses and
   ports of the authcache instances, including those of our newly-provisioned
   zone "a2674d3b-a9c4-46bc-a835-b6ce21d522c2".  Binder caches this information
   for subsequent queries.
6. Binder translates this information into the appropriate DNS answers (usually
   "A" records or "SRV" records, depending on what the DNS client asked for).

If the zone is destroyed, or the server on which it's running reboots or powers
off or becomes partitioned, Registrar will become disconnected from ZooKeeper
and its session will expire.  This causes its ephemeral node to disappear from
ZooKeeper.  Once the Binder caches expire and they re-fetch the state from
ZooKeeper, they will no longer find information about the zone that's gone, so
they will stop including that zone in DNS answers.  Clients will shortly stop
using the zone.

In this way:

- clients of a service (like "authcache") discover instances using DNS
- instances are added to DNS automatically when they start up
- instances are removed from DNS automatically for many (but not all) failures

Note that even in the best of cases, there is a non-trivial delay between when
an instance fails and when clients see that and stop using it.  For the instance
to fall out of DNS, Registrar's ZooKeeper session timeout must expire (usually
30-40 seconds), Binder's cache must expire (currently another 60 seconds), and
the DNS records fetched by clients must also expire (usually another 30-60
seconds, but this is configurable per-service, and it may actually take much
longer than that).  **Clients must still deal with failures of instances that
are present in DNS.**  DNS is the way that clients discover what instances they
might be able to use, but it should not be assumed that all those instances are
currently operating.

**Health checking:** Registrar runs separately from the program that actually
provides service (the actual authentication cache process, in this example).  So
it's also possible for the real service to crash or go offline while registrar
is still online.  Registrar supports basic health checking by executing a
command periodically and unregistering an instance if the command fails too many
times in too short a period.  However, as of this writing, this mechanism is
extremely buggy.  See [HEAD-2282](http://smartos.org/bugview/HEAD-2282) and
[HEAD-2283](http://smartos.org/bugview/HEAD-2283).

**SRV-based discovery:** Many services (like
[Moray](https://github.com/joyent/moray)) use multiple processes in order to
make use of more than one CPU.  The recommended way to implement this is to
configure registrar to publish specific port information.  This allows Binder to
answer queries with SRV records, which allow clients to discover not just
individual zones, but the specific ports available in those zones.


## Operating Registrar

### Configuration

The configuration file is almost always immutable and based on a template that's
checked into the repository of a component that uses registrar.  Details are
described under "Developing with Registrar" below.

### Removing instances from service

There are many reasons why it's useful to remove an instance from DNS so that
clients stop using it:

- in development, this is useful to direct traffic at particular instances, or
  to test client behavior when instances come and go
- in production, this is useful to isolate malfunctioning instances.  You can
  remove these instances from service without actually halting them so that you
  can continue debugging them.

The usual way to do this is to disable the registrar SMF service in the zone you
want to remove from DNS:

    svcadm disable -st registrar

You can bring this zone back into DNS using:

    svcadm enable -s registrar


## Developing with Registrar

### Incorporating Registrar into a component

As mentioned above, Registrar is deployed in nearly all Triton and Manta
component zones.  Incorporating Registrar into a new component usually involves
only a few steps:

- the component's repository should include a template configuration file,
  usually in `sapi_manifests/registrar/template` and an associated config-agent
  snippet in the same directory
- the [Mountain Gorilla](https://github.com/joyent/mountain-gorilla) (build
  system) configuration snippet for this component should depend on the
  registrar tarball

In the most common case, the Registrar configuration file is itself generated by
[config-agent](https://github.com/joyent/sdc-config-agent) using the template
that's checked into the repository.  In some cases (notably Moray), there's an
additional step either at build time or zone setup time where the template
itself is templatized by the list of TCP ports that should be exposed.

When new instances (zones) of the component start up, config-agent writes the
registrar configuration file, populating variables such as the DNS domain suffix
("emy-10.joyent.us" in the example above) from the SAPI configuration for the
current deployment.  After that, Registrar starts up, reads the configuration
file, and runs through the process described at the top of this README.


### Configuration reference

The configuration file is specified using the "-f" argument to "main.js".  The
file is a JSON object with top-level properties:

Property         | Type            | Description
---------------- | --------------- | -----------
`"adminIp"`      | optional string | IPv4 address to include in DNS records
`"zookeeper"`    | object          | describes how to connect to the ZooKeeper cluster
`"registration"` | object          | describes which DNS names should be created for this component

**adminIp:**  The address for all DNS answers related to this component is
whatever is provided by the `"adminIp"` configuration property.  This is the IP
address used by clients that use DNS to discover this component.  For Triton
components, this should usually be an addresss on the "admin" network (hence the
name).  For Manta components, this should usually be an address on the "manta"
network.  If `"adminIp"` is not specified in the configuration, then Registrar
picks an up, non-loopback IP address on the system and uses that, but this is
not recommended.

**zookeeper:** Service discovery records are maintained in a
ZooKeeper cluster.  The `"zookeeper"` top-level property describes how to reach
that cluster.  This should be a configuration block appropriate for
[node-zkstream](http://github.com/joyent/node-zkstream).  See that project for
details, but there's an example below that includes `"sessionTimeout"` and
`"servers"` properties.

**registration:** The `"registration"` object describes the service discovery
records that will be inserted into ZooKeeper.  These control the DNS names that
are available for this component.  Broadly, there are two types of service
discovery records:

* **Host records** essentially allow Binder to answer DNS "A" and "SRV" queries
  with the IP address (and possibly port numbers) for a single instance.  More
  precisely, host records are individual nodes in the ZooKeeper namespace that
  provide address and port information for a single zone.  These are ephemeral,
  which means they disappear when Registrar's ZooKeeper session expires.  That's
  by design so that if a zone disappears, it stops showing up in DNS.
* **Service records** allow Binder to answer DNS "A" and "SRV" queries for a
  single logical service that's provided by any number of interchangeable
  instances.  The list of instances available are represented by host records
  that are child nodes of the service record (within the ZooKeeper namespace).


#### Using host and service records

Let's look at an example.  In Manta, instances of the "authcache" service
publish host records under "$zonename.authcache.$suffix".  As a result, if you
have a Manta deployment whose DNS suffix is "emy-10.joyent.us", you can find the
IP address for the "authcache" zone that's called
"a2674d3b-a9c4-46bc-a835-b6ce21d522c2" by looking up
"a2674d3b-a9c4-46bc-a835-b6ce21d522c2.authcache.emy-10.joyent.us":

    $ dig +nocmd +nocomments +noquestion +nostats a2674d3b-a9c4-46bc-a835-b6ce21d522c2.authcache.emy-10.joyent.us
    a2674d3b-a9c4-46bc-a835-b6ce21d522c2.authcache.emy-10.joyent.us. 30 IN A 172.27.10.62

We've just looked up the _host record_ for a particular authcache instance.  The
authcache service also writes a _service record_ for the higher-level DNS name
"authcache.emy-10.joyent.us".  This lets clients of the authcache service use
the DNS name "authcache.emy-10.joyent.us" to find all available authcache
instances:

    $ dig +nocmd +nocomments +noquestion +nostats authcache.emy-10.joyent.us
    authcache.emy-10.joyent.us. 30  IN      A       172.27.10.67
    authcache.emy-10.joyent.us. 30  IN      A       172.27.10.62

**Summary:** A service can provide host records (when there's only one IP
address for a given DNS name) or service records (when there may be multiple
interchangeable instances).


#### Configuring the registration

The `registration` block of the configuration file determines which records are
created.  This block contains properties:

Property    | Type                     | Description
----------- | ------------------------ | -----------
`"domain"`  | string                   | DNS name under which records will be created for this instance
`"aliases"` | optional array of string | array of fully-qualified DNS names to create as additional host records for this instance
`"type"`    | string                   | the specific subtype of record to use for the host records created for this instance
`"service"` | optional object          | if present, a service record will be created with properties described by this object (see below)
`"ttl"`     | optional number          | if present, this may be used for the TTL of the host record.  See "Using TTLs" below.

With this information, Registrar creates the following records:

* A host record is *always* created at `$(hostname).$domain`.  The use of
  `$(hostname)` here refers to the system's hostname (see hostname(1)) and
  `$domain` refers to the configuration property above.
* If the `aliases` array is present, then additional host records are created
  for each string in the array.  These should be fully qualified — they should
  generally end with the value of `domain`.
* If `service` is present, a service record is created at the DNS name `$domain`
  itself.  The `service` object is described below.


#### Registration of host records

All records — host records and service records — internally have a specific
`type`.  The `"type"` property above controls the types used for the host
records that Registrar creates.  (Service records always have type `"service"`,
and any type other than `"service"` indicates a host record.)  The specific
`"type"` determines exactly how Binder uses them.  The following types are
supported:

Type              | Can be queried directly? | Can be used for Service?
----------------- | ------------------------ | ------------------------
`"db_host"`       | yes                      | no
`"host"`          | yes                      | no
`"load_balancer"` | yes                      | yes
`"moray_host"`    | yes                      | yes
`"ops_host"`      | no                       | yes
`"redis_host"`    | yes                      | yes
`"rr_host"`       | no                       | yes

For types that cannot be queried directly ("ops\_host" and "rr\_host"), if you
query the corresponding DNS name, Binder will behave as though they weren't
there.  This is not generally useful in new components.

For types that cannot be used as a service ("db\_host" and "host"), if these
records are found as child nodes of a "service" record, they will not be
included in the DNS results for the service itself.  This is not generally
useful in new components.

In a simpler world, all host record types could be queried directly (meaning
that when you look up a DNS name that maps to a host record of that type, Binder
answers with the address information in that record), and they could also be
used as backing hosts for a "service" record.  For historical reasons, that's
not true, and it's not easy to change because there are services (notably
"webapi" and "loadbalancer") that share a DNS name today, but where only one of
them is intended to be enumerable.

**Summary:** The most common case is that each instance of a component is
interchangeable, and clients can talk to any one of them.  In that case, you
should use host records of type `"load_balancer"` and separately configure a
"service" record.  This will cause `"domain"` to be a DNS name that lists all of
the active instances' IP addresses, and `$zonename.$domain` can be used to find
the address of specific instances when that's needed (mostly for debugging).  On
the other hand, if you want to create standalone host records that aren't part
of a logical service, use type `"host"` and do not create an associated service
record.  This is not common.

**Example:** Here's an example Registrar configuration:

    {
        "registration": {
            "type": "load_balancer",
            "domain": "example.joyent.us",
            "aliases": [
                "host-1a.example.joyent.us",
                "host-1b.example.joyent.us"
            ]
        },
        "adminIp": "172.27.10.72",
        "zookeeper": {
            "sessionTimeout": 60000,
            "servers": [ { "address": "172.27.10.35", "port": 2181 },
                         { "address": "172.27.10.32", "port": 2181 },
                         { "address": "172.27.10.33", "port": 2181 } ]
        }
    }

In these and subsequent examples, "172.27.10.72" is the IP address of the
Registrar instance on the network on which we're providing the
"example.joyent.us" service.  The "zookeeper" block is specific to this
deployment and points Registrar at the ZooKeeper cluster.

This example specifies that we're registering an instance of the service
"example.joyent.us".  This will create three host records: one for the Registrar
instance's hostname (which is "b44c74d6" in this case) and one for each of the
two aliases "host-1a.example.joyent.us" and "host-1b.example.joyent.us".  We can
look up any of these:

    $ dig host-1a.example.joyent.us +short
    172.27.10.72
    $ dig host-1b.example.joyent.us +short
    172.27.10.72
    $ dig b44c74d6.example.joyent.us +short
    172.27.10.72

This configuration did not specify `"service"`, so there are no service-level
records, so there's no way to list all of the hosts under "example.joyent.us".
(As of this writing, if you try to lookup "example.joyent.us", Binder will crash
because of [MANTA-3058](https://smartos.org/bugview/MANTA-3058).)

#### Registration of service records

As mentioned above, service records are used for two purposes:

- to indicate that a particular DNS name is served by any of several
  interchangeable instances
- to provide service, protocol, and port information so that Binder can answer
  SRV queries

To have Registrar create a service record, specify a `"service"` property under
the `"registration"` object.  The `"service"` object must have a property
`"type"` with value `"service"` and another `"service"` object with properties:

Property  | Type            | Meaning
--------- | --------------- | -------------------------------
`"srvce"` | string          | service to use for SRV answers.  (The name `"srvce"` is correct, not a typo.)
`"proto"` | string          | protocol to use for SRV answers
`"port"`  | number          | port to use for SRV answers _when a child host record does not contain its own array of ports_.
`"ttl"`   | optional number | TTL to use for SRV answers.  See "Using TTLs" below.

Note that the presence of `"service"` causes Registrar to create a service
record, and the various fields are required, so it's not possible to specify a
service record without also providing the information required to answer SRV
queries.

Let's augment the configuration above to specify a service record:

    {
        "registration": {
            "type": "load_balancer",
            "domain": "example.joyent.us",
            "service": {
                "type": "service",
                "service": {
                    "srvce": "_http",
                    "proto": "_tcp",
                    "port": 80
                }
            }
        },
        "adminIp": "172.27.10.72",
        "zookeeper": {
            "sessionTimeout": 60000,
            "servers": [ { "address": "172.27.10.35", "port": 2181 },
                         { "address": "172.27.10.32", "port": 2181 },
                         { "address": "172.27.10.33", "port": 2181 } ]
        }
    }

(We also dropped the aliases from this example because those were just for
demonstration.)

With the service configuration in place, we can still look up the IP address
for a specific instance:

    $ dig b44c74d6.example.joyent.us +short
    172.27.10.72

but we can also list all instances:

    $ dig example.joyent.us +short
    172.27.10.72

If we start up another Registrar instance with a similar configuration with IP
address 172.27.10.73, then we'd get both results:

    $ dig example.joyent.us +short
    172.27.10.72
    172.27.10.73

Note that because the service record configuration includes port numbers,
Binder can now answer SRV queries as well.  To make these queries with dig(1),
we specify `-t SRV` (to ask for SRV answers) and specify a DNS name starting
with `_http._tcp.` (because it's conventional for SRV requests to prepend the
service and protocol names to the DNS name that you'd otherwise be using for
the service):

    $ dig -t SRV +nocmd +nocomments +noquestion +nostats _http._tcp.example.joyent.us
    _http._tcp.example.joyent.us. 60 IN     SRV     0 10 80 b44c74d6.example.joyent.us.
    b44c74d6.example.joyent.us. 30  IN      A       172.27.10.72

SRV queries allow clients to discover each of several instances running inside
a container.  This is the preferred approach for new services because it
eliminates the need for a local loadbalancer, which improves performance and
availability and also simplifies debugging.


## ZooKeeper data format

This section describes the structure of service discovery records that are
stored in ZooKeeper.  You don't need this unless you're debugging or developing
Registrar or ZooKeeper.

The service discovery information in ZooKeeper is always written by Registrar
and read by Binder.  It's thus a contract between these components.  However, it
was historically not documented, and several pieces are redundant or confusing.
Additionally, this information is not thoroughly validated in Binder.

**Caveat:** This information is provided for reference only.  The existing
implementation is not crisp enough, validated enough, or committed enough to use
this information to write an alternate implementation and expect that it will
interoperate with the existing one.

**Before reading this section, be sure to read and understand the "Configuration
reference" section.  It covers the basic underlying concepts that are used in
this section.**


### ZooKeeper paths

ZooKeeper provides a filesystem-like API: there's a hierarchical,
slash-delimited namespace of objects.  Data about DNS domains is stored into
ZooKeeper in paths derived from the domains by reversing the components of the
domain and replacing dots (".") with slashes ("/").  So the information for
domain "authcache.emy-10.joyent.us" is contained under
"/us/joyent/emy-10/authcache" in the ZooKeeper namespace.

For a service like authcache, the typical ZooKeeper node structure looks
like this:

* "/us/joyent/emy-10/authcache" contains the service record for "authcache".
* Nodes underneath this path (like
  "/us/joyent/emy-10/authcache/a2674d3b-a9c4-46bc-a835-b6ce21d522c2") contain
  host records for individual instances of "authcache".

The ZooKeeper analog of directory nodes can themselves contain data, so the node
at "/us/joyent/emy-10/authcache" acts as both an object and a directory.

### Overview of service discovery records

All of the ZooKeeper nodes written by Registar contain JSON payloads.  We call
these **service discovery records**.  Internally, every service discovery record
includes:

- a required `"type"`, a string identifying the specific type of this record.
- a required property with the same name as the type that provides type-specific
  details, described below.  For example, if the `type` has value `"service"`,
  then there will be a top-level property called `"service"` that contains more
  information.  If the `type` is `"moray_host"`, the top-level property with the
  rest of the details will be called `"moray_host"`.

There are broadly two kinds of records: **host records** and **service
records**.  As described above, host records indicate that a DNS name maps to a
particular host (usually a zone or container).  Service records indicate that a
DNS name is served by one or more other hosts that are specified by child nodes
in the ZooKeeper tree.  Binder will reply to DNS requests with information about
all of the hosts that it finds underneath a "service" record.

If we query Binder for `A` records for `authcache.emy-10.joyent.us`, we expect
to get a list of IP addresses for the various instances of `authcache`.  We
expect we can connect to any of these instances on some well-known port to use
the `authcache` service.  How does this work?

When we query Binder for `authcache.emy-10.joyent.us`, assuming the result is
not cached, Binder fetches the ZooKeeper node at "/us/joyent/emy-10/authcache".
There, it finds a service record (with `"type" == "service"`):

    {
      "type": "service",
      "service": {
        "type": "service",
        "service": {
          "srvce": "_redis",
          "proto": "_tcp",
          "port": 6379,
          "ttl": 60
        },
        "ttl": 60
      }
    }

Seeing a service record, Binder then _lists_ the children of the ZooKeeper node
"/us/joyent/emy-10/authcache" to find host records for individual instances of
the `authcache` service.  (Remember, ZooKeeper's namespace looks like a
filesystem, but the nodes that you'd think of as directories can themselves also
contain data.  In this case, the _data_ at "/us/joyent/emy-10/authcache" is the
service record.  The child nodes in that directory describe the specific
instances.)  In this example, that includes two instances:

* a2674d3b-a9c4-46bc-a835-b6ce21d522c2
* a4ae094d-da07-4911-94f9-c982dc88f3cc

Binder also fetches the contents of the child nodes.  These records look like
this:

    {
      "type": "redis_host",
      "address": "172.27.10.62",
      "ttl": 30,
      "redis_host": {
        "address": "172.27.10.62",
        "ports": [ 6379 ]
      }
    }

    {
      "type": "redis_host",
      "address": "172.27.10.67",
      "ttl": 30,
      "redis_host": {
        "address": "172.27.10.67",
        "ports": [ 6379 ]
      }
    }

The record includes the IP address and TTLs that will be included in DNS
answers.  In this case, there are two addresses for
"authcache.emy-10.joyent.us":

    $ dig +nocmd +nocomments +noquestion +nostats authcache.emy-10.joyent.us
    authcache.emy-10.joyent.us. 30  IN      A       172.27.10.67
    authcache.emy-10.joyent.us. 30  IN      A       172.27.10.62

In order to use these, clients need to know the TCP port that the `authcache`
service uses.

Note that clients can also query for the host records directly:

    $ dig +nocmd +nocomments +noquestion +nostats a2674d3b-a9c4-46bc-a835-b6ce21d522c2.authcache.emy-10.joyent.us
    a2674d3b-a9c4-46bc-a835-b6ce21d522c2.authcache.emy-10.joyent.us. 30 IN A 172.27.10.62

In this case, Binder answers the query by fetching the ZooKeeper node
"/us/joyent/emy-10/authcache/a2674d3b-a9c4-46bc-a835-b6ce21d522c2", finding the
host record there, and producing an "A" record.  The service record is not
involved here.

Service records also include the information required for Binder to answer DNS
SRV queries.  These allow clients to find all available servers running inside a
container, which allows for more effective load balancing and resiliency than
using a separate load balancer.  For a worked example, see the "Configuration
reference".


### Host record reference

Host records are usually ephemeral nodes in ZooKeeper, which means they are
removed when the corresponding Registrar becomes disconnected from ZooKeeper.

Host records have the following top-level properties:

Property    | Type                       | Meaning
----------- | -------------------------- | -------
`"address"` | string                     | Apparently unused.  Possibly historical.
`"type"`    | string                     | Subtype of host record.  See below.
`"ttl"`     | optional integer           | See "About TTLs" below.
`type`      | object                     | The property name always matches the value of `"type"`.  See below for details.

Host records are distinguished from service records by having any `"type"` other
than `"service"`.  Supported values of `"type"` (and the semantics of each type)
are the same as those supported in the [Registrar configuration
reference](#configuration-reference).  The various types of host records largely
function the same way: each of these records causes Binder to produce either one
`"A"` record with the IP address of that instance or multiple `"SRV"` records
with the IP address and ports of the various instances contained inside the
zone.  (There's also a vestigial type called `"database"` which was historically
produced by Manatee, but this type of record is neither produced nor consumed
any more.)

The inner object (that has the same name as the value of `"type"`) has
properties:

Property    | Type                       | Meaning
----------- | -------------------------- | -------
`"address"` | string                     | IPv4 address to use for A and SRV query responses.
`"ports"`   | optional array of integers | TCP ports to use for SRV records.  Binder generates one SRV answer for each element of this array.
`"ttl"`     | optional integer           | See "About TTLs" below.

Here's a host record created from our example above:

    {
      "type": "load_balancer",
      "address": "172.27.10.72",
      "load_balancer": {
        "address": "172.27.10.72",
        "ports": [ 80 ]
      }
    }

When queried for "A" records, Binder reports one for 172.27.10.72.  When queried
for SRV records, assuming the parent node (in ZooKeeper) for this host record is
a service record, then Binder uses the protocol and service mentioned in the
"service" record to generate an SRV answer for each port contained in this
record.


### Service record reference

Service records are those with `"type"` equal to `"service"`.  These are
persistent nodes in ZooKeeper.

Service records have the following top-level properties:

Property    | Type                       | Meaning
----------- | -------------------------- | -------
`"type"`    | string                     | Always has value "service".  (Otherwise, this is a host record.)
`"service"` | object                     | Describes the service name, protocol name, and TTL used for answering SRV queries about this service.  The format of this object exactly matches the `registration.service` object in the Registrar configuration.

Here's a service record created from our example above:

    {
      "type": "service",
      "service": {
        "type": "service",
        "service": {
          "srvce": "_http",
          "proto": "_tcp",
          "port": 80,
          "ttl": 60
        }
      }
    }

DNS SRV records also support weights, but these are not supported by Registrar
or Binder.


### About TTLs

The semantics around which TTLs are used in DNS responses are surprisingly
complex.  In all cases, Binder provides default TTL values when no value is
specified by any of the mechanisms below.

When looking up the IP address of a specific instance (not a service), you
generally query Binder for "A" records for a DNS name that corresponds to a host
record.  In this case, the TTL is selected from whichever of the following is
specified, in this order:

* a TTL on the inner object within the host record (e.g.,
  `hostRecord[hostRecord.type].ttl`).
* a TTL on the host record itself (e.g., `hostRecord.ttl`)

When looking up a service's DNS name, you query Binder for "A" or "SRV" records
for a DNS name that corresponds to a service record.  In this case, Binder
produces both "SRV" answers (that describe the instances available, using the
DNS name for each host and a port number) and "A" answers as additionals
(containing the resolutions for the hostnames provided in the "SRV" answers).
For example, when you ask for the SRV records for
"\_http.\_tcp.example.joyent.us", you get:

    $ dig +nocmd +nostats -t SRV _http._tcp.example.joyent.us
    ;; Got answer:
    ;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 6415
    ;; flags: qr rd ad; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 2
    ;; WARNING: recursion requested but not available

    ;; OPT PSEUDOSECTION:
    ; EDNS: version: 0, flags:; udp: 1470
    ;; QUESTION SECTION:
    ;_http._tcp.example.joyent.us.  IN      SRV

    ;; ANSWER SECTION:
    _http._tcp.example.joyent.us. 60 IN     SRV     0 10 80 b44c74d6.example.joyent.us.

    ;; ADDITIONAL SECTION:
    b44c74d6.example.joyent.us. 30  IN      A       172.27.10.72

Binder is telling us that there's an instance at "b44c74d6.example.joyent.us"
port 80, and it's separately telling us that the address for
"b44c74d6.example.joyent.us" is 172.27.10.72.  **These two results can have
different TTLs.**  The TTL on the SRV records indicates how long the client
should cache the list of instances.  Changes to this list should be propagated
quickly, so we typically use TTLs on the order of 30 to 60 seconds.  However,
the TTLs on the "A" resolutions can be much longer, because it's almost unheard
of for the IP address to change for a specific Triton or Manta zone.

There are basically two possibilities here:

- If the TTL on the SRV records is shorter than or equal to that of the
  additional A records, then the client will generally re-resolve the SRV name
  as frequently as its TTL indicates.  Since Binder always provides additionals
  for the A records, the client never needs to re-resolve the A records.  The
  client ends up re-resolving all records on an interval specified by the SRV
  TTL.
- If the TTL on the SRV records is longer than that of the A records, then a
  client would have to re-resolve the A records more frequently than the SRV
  records.  That would likely result in significantly more load on Binder than
  is desirable.  There's also not much reason to do this, since the addresses
  for individual zones don't generally change.

As a result, there's not generally much reason to have the TTLs differ between
SRV records and A records, at least without significant changes to the way
Binder and clients usually work.

Given all that, when you make an "SRV" query for a DNS name corresponding to a
service (not a host), the TTL for the SRV records is selected from whichever of
the following is specified, in this order:

* a TTL on the service record's service details
  (`serviceRecord.service.service.ttl`)
* a TTL on the inner record on the service record (`serviceRecord.service.ttl`)
* a TTL on the service record itself (`serviceRecord.ttl`)

For the same query, the TTL for the "A" records is selected from:

* a TTL on the child host record's inner record
  (`hostRecord[hostRecord.type].ttl`)
* a TTL on the child host record itself (`hostRecord.ttl`)

When you make an "A" query for the same DNS name, the TTL used is the minimum of
the above two TTLs (since the response represents both the list of instances and
the addresses of each instance).


## Debugging Notes

When Binder isn't reporting the results that you expect, ask the following
questions.

### Do you expect that the DNS results recently changed?

DNS results may change any time a Registrar instance establishes a new ZooKeeper
session to ZooKeeper or loses its ZooKeeper session.  There are a few reasons
why this can take some time to be reflected in Binder:

- Binder caches all ZooKeeper queries for up to 60 seconds.
- ZooKeeper sessions can take up to 60 seconds to expire (depending on the
  Registrar configuration).
- DNS clients cache the answers to queries for up to the TTL on each answer.
  This is typically 30-60 seconds, but can be several minutes, depending on the
  component.

As a result, when Registrar first starts up, it can take up to a minute for the
new registration to be reflected in any particular Binder instance.  When
Registrar shuts down (or the underlying server powers off, panics, or becomes
partitioned), it can take at least two minutes for that to be reflected in
Binder, and clients may not discover the change for an additional `TTL` seconds.

Since the Binder instances operate independently (and cache independently), you
can get inconsistent results if you make the same query against different
Binders before they've all learned about recent updates.

### Does the structure of records in ZooKeeper reflect what you expect?

Use `zkCli.sh` (the ZooKeeper CLI) inside any "binder" or "nameservice" zone to
answer this question.  (Run it with no arguments and use the `help` command to
get started.)

- If you're querying a service (e.g., "example.joyent.us"), you should find a
  "service" record at the corresponding ZooKeeper node (e.g.,
  `get /us/joyent/example`).  You can `ls /us/joyent/example` that path to see
  the child nodes.  Do you see the entries for hosts you expect to be there?
  You can "get" each of these.  You should find host records for the addresses
  that appear in DNS.
- If you're querying a host (e.g., "$hostname.example.joyent.us"), you should
  just find a host record at the corresponding ZooKeeper node.

Remember too that only certain types of host records can be used with service
DNS names.  If you're using a record of type "db\_host" or "host", it won't show
up when you query the service DNS name.  See "Registration of host records"
under the configuration reference above for details.

If you don't find the records you expect in ZooKeeper, your Registrar
configuration may be incorrect, or Registrar may not be functioning.  If you do,
Binder may not be working correctly.


## License

Registrar is licensed under the
[Mozilla Public License version 2.0](http://mozilla.org/MPL/2.0/).
