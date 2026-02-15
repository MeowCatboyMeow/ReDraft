#!/usr/bin/env node

/**
 * ReDraft Server Plugin Installer
 *
 * Copies the server plugin files to SillyTavern's plugins directory
 * and enables server plugins in config.yaml if needed.
 *
 * Usage: Run from your SillyTavern root directory:
 *   node data/<user>/extensions/third-party/redraft/server-plugin/install.js
 *
 * Or if developing locally:
 *   node public/scripts/extensions/third-party/redraft/server-plugin/install.js
 */

const fs = require('fs');
const path = require('path');

const PLUGIN_NAME = 'redraft';

// Determine paths
const scriptDir = __dirname;
const stRoot = findSTRoot(scriptDir);

if (!stRoot) {
    console.error('ERROR: Could not locate SillyTavern root directory.');
    console.error('Make sure you run this script from within a SillyTavern installation.');
    process.exit(1);
}

const pluginsDir = path.join(stRoot, 'plugins');
const targetDir = path.join(pluginsDir, PLUGIN_NAME);

console.log(`ReDraft Server Plugin Installer`);
console.log(`================================`);
console.log(`SillyTavern root: ${stRoot}`);
console.log(`Target: ${targetDir}`);
console.log('');

// Create plugins directory if it doesn't exist
if (!fs.existsSync(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true });
    console.log(`Created plugins directory: ${pluginsDir}`);
}

// Create target directory
if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
}

// Copy plugin files (everything except install.js itself)
const filesToCopy = ['index.js', 'config.json.example'];
let copied = 0;

for (const file of filesToCopy) {
    const src = path.join(scriptDir, file);
    const dest = path.join(targetDir, file);

    if (!fs.existsSync(src)) {
        console.warn(`  SKIP: ${file} (not found in bundle)`);
        continue;
    }

    fs.copyFileSync(src, dest);
    console.log(`  Copied: ${file}`);
    copied++;
}

console.log(`\n${copied} file(s) installed to ${targetDir}`);

// Check and update config.yaml
const configPath = path.join(stRoot, 'config.yaml');
const defaultConfigPath = path.join(stRoot, 'default', 'config.yaml');

if (fs.existsSync(configPath)) {
    let config = fs.readFileSync(configPath, 'utf-8');
    if (config.includes('enableServerPlugins: false')) {
        config = config.replace('enableServerPlugins: false', 'enableServerPlugins: true');
        fs.writeFileSync(configPath, config, 'utf-8');
        console.log('\nEnabled server plugins in config.yaml');
    } else if (config.includes('enableServerPlugins: true')) {
        console.log('\nServer plugins already enabled in config.yaml');
    } else {
        console.log('\nWARNING: Could not find enableServerPlugins in config.yaml.');
        console.log('Please manually set "enableServerPlugins: true" in your config.yaml');
    }
} else {
    // No config.yaml yet — copy from default and enable plugins
    if (fs.existsSync(defaultConfigPath)) {
        let config = fs.readFileSync(defaultConfigPath, 'utf-8');
        config = config.replace('enableServerPlugins: false', 'enableServerPlugins: true');
        fs.writeFileSync(configPath, config, 'utf-8');
        console.log('\nCreated config.yaml from defaults with server plugins enabled');
    } else {
        console.log('\nWARNING: No config.yaml found. Please create one and set "enableServerPlugins: true"');
    }
}

console.log('\n================================');
console.log('Installation complete! Restart SillyTavern to activate the server plugin.');
console.log('Then configure your API credentials in the ReDraft extension settings.');

/**
 * Walk up from the script location to find the ST root
 * (identified by the presence of server.js or package.json with "sillytavern").
 */
function findSTRoot(startDir) {
    let dir = path.resolve(startDir);
    const root = path.parse(dir).root;

    while (dir !== root) {
        const serverJs = path.join(dir, 'server.js');
        const packageJson = path.join(dir, 'package.json');

        if (fs.existsSync(serverJs) && fs.existsSync(packageJson)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf-8'));
                if (pkg.name === 'sillytavern' || pkg.name === 'silly-tavern-server') {
                    return dir;
                }
            } catch { /* ignore parse errors */ }
        }

        dir = path.dirname(dir);
    }

    return null;
}
