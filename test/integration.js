'use strict';

const path = require('node:path');
const { tests } = require('@iobroker/testing');

// Starts the adapter in a temporary js-controller instance (no devices configured)
tests.integration(path.join(__dirname, '..'));
