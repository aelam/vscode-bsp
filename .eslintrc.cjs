module.exports = {
    root: true,
    parser: '@typescript-eslint/parser',
    parserOptions: { ecmaVersion: 2020, sourceType: 'module' },
    env: { node: true, es2020: true },
    extends: ['eslint:recommended'],
    rules: {
        'no-undef': 'off',
        'no-unused-vars': 'off',
        'no-constant-condition': ['error', { checkLoops: false }],
        'no-empty': ['error', { allowEmptyCatch: true }]
    }
};
