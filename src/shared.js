'use strict';

const fs = require('fs');
const path = require('path');

function shared(name) {
    if (!/^[a-z0-9-]+$/i.test(name)) throw new Error(`Invalid shared module: ${name}`);
    return require(path.join(__dirname, '..', 'shared', name));
}

function asset(name) {
    const resource = process.resourcesPath ? path.join(process.resourcesPath, 'assets', name) : '';
    const packaged = path.join(__dirname, '..', 'assets', name);
    const unpacked = packaged.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    return resource && fs.existsSync(resource) ? resource : fs.existsSync(unpacked) ? unpacked : packaged;
}

module.exports = { shared, asset };
