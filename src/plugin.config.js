import { createId } from '@paralleldrive/cuid2';
export default {
    ce_prefix: createId(),
    identifier: 'me.stormy.immer-sync',
    name: 'ImmerSync',
    description: 'Just syncs the song beats to the Immersive Background (Not the most accurate)',
    version: '1.0.0',
    author: 'stormy-soul',
    repo: 'https://github.com/stormy-soul/immer-sync',
    entry: {
        'plugin.js': {
            type: 'main',
        }
    }
};
