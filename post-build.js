import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read the plugin config
const configPath = join(__dirname, 'src', 'plugin.config.ts');
const configContent = await import(configPath);
const config = configContent.default;

// Convert to YAML
const yamlContent = yaml.stringify(config);

// Write to dist
const destPath = join(__dirname, 'dist', config.identifier, 'plugin.yml');

try {
  writeFileSync(destPath, yamlContent, 'utf8');
  console.log('✓ Created plugin.yml in dist');
  console.log('Plugin identifier:', config.identifier);
} catch (error) {
  console.error('Failed to create plugin.yml:', error);
  process.exit(1);
}