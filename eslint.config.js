import tseslint from 'typescript-eslint'
export default tseslint.config({ ignores: ['dist'], files: ['src/**/*.ts'], extends: [...tseslint.configs.recommended] })
