#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2022 Joyent, Inc.
#

#
# Files
#
JS_FILES	:= $(shell ls *.js)
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE   = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS    = -f tools/jsstyle.conf
SMF_MANIFESTS_IN = smf/manifests/registrar.xml.in

#
# Variables
#

# RELENG-341: no npm cache is making builds unreliable
NPM_FLAGS :=

NODE_PREBUILT_VERSION=v6.17.0
ifeq ($(shell uname -s),SunOS)
	NODE_PREBUILT_TAG=zone
	# Use sdcnode built for multiarch-15.4.1
	NODE_PREBUILT_IMAGE=18b094b0-eb01-11e5-80c1-175dac7ddf02
endif

ENGBLD_REQUIRE := $(shell git submodule update --init deps/eng)
include ./deps/eng/tools/mk/Makefile.defs
TOP ?= $(error Unable to access eng.git submodule Makefiles.)

ifeq ($(shell uname -s),SunOS)
	include ./deps/eng/tools/mk/Makefile.node_prebuilt.defs
else
	NPM_EXEC :=
	NPM = npm
	NODE = node
endif
include ./deps/eng/tools/mk/Makefile.smf.defs

#
# Env vars
#
PATH	:= $(NODE_INSTALL)/bin:${PATH}
NAME	= registrar

#
# MG Variables
#

RELEASE_TARBALL         := $(NAME)-pkg-$(STAMP).tar.gz
ROOT                    := $(shell pwd)
RELSTAGEDIR             := /tmp/$(NAME)-$(STAMP)

#
# Repo-specific targets
#
.PHONY: all
all: $(SMF_MANIFESTS) | $(NPM_EXEC) $(REPO_DEPS)
	$(NPM) install

.PHONY: test
test:
	@echo "No tests"

.PHONY: release
release: all $(SMF_MANIFESTS)
	@echo "Building $(RELEASE_TARBALL)"
	@mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/registrar
	@mkdir -p $(RELSTAGEDIR)/site
	@touch $(RELSTAGEDIR)/site/.do-not-delete-me
	@mkdir -p $(RELSTAGEDIR)/root
	@mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/registrar/etc
	cp -r   $(ROOT)/lib \
		$(ROOT)/main.js \
		$(ROOT)/node_modules \
		$(ROOT)/package.json \
		$(ROOT)/smf \
		$(RELSTAGEDIR)/root/opt/smartdc/registrar
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/registrar/build
	cp -r \
		$(ROOT)/build/node \
		$(RELSTAGEDIR)/root/opt/smartdc/registrar/build
	(cd $(RELSTAGEDIR) && $(TAR) -I pigz -cf $(ROOT)/$(RELEASE_TARBALL) root site)
	@rm -rf $(RELSTAGEDIR)


.PHONY: publish
publish: release
	@if [[ -z "$(ENGBLD_BITS_DIR)" ]]; then \
		echo "error: 'ENGBLD_BITS_DIR' must be set for 'publish' target"; \
		exit 1; \
	fi
	mkdir -p $(ENGBLD_BITS_DIR)/registrar
	cp $(ROOT)/$(RELEASE_TARBALL) $(ENGBLD_BITS_DIR)/registrar/$(RELEASE_TARBALL)


include ./deps/eng/tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
	include ./deps/eng/tools/mk/Makefile.node_prebuilt.targ
endif
include ./deps/eng/tools/mk/Makefile.smf.targ
include ./deps/eng/tools/mk/Makefile.targ
