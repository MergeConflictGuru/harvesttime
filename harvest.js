const { app } = require('electron');
const process = require('process');

const choice = process.argv[2];
const customPath = process.argv[3] || '.'; // Default to current directory if no path is provided

// A simple way to pass data to the required module
process.customData = { path: customPath };

if (choice === 'google') {
    require('./harvest-g-photos.js');
} else if (choice === 'grok') {
    require('./harvest-grok-imagine.js');
} else {
    console.log('Please specify which harvester to run.');
    console.log('Usage: npm run harvest:grok -- [path/to/save]');
    app.quit();
}
