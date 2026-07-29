import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import jsdoc from 'eslint-plugin-jsdoc';

export default tseslint.config(
  {
    ignores: ['dist/**', 'test/**', '**/*.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    plugins: {
      jsdoc,
    },
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Type safety
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Allow namespaces for type grouping
      '@typescript-eslint/no-namespace': 'off',

      // JSDoc: validate existing doc comments
      'jsdoc/check-param-names': 'warn',
      'jsdoc/check-tag-names': 'warn',
      'jsdoc/check-types': 'warn',
      'jsdoc/valid-types': 'warn',

      // SQL Injection Prevention Rules
      'no-template-curly-in-string': 'error',
      
      // Custom SQL injection detection rules
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TemplateLiteral[expressions.length>0][quasis.0.value.raw*="SELECT"]',
          message: 'Potential SQL injection: Avoid template literals with variables in SELECT statements. Use parameterized queries instead.'
        },
        {
          selector: 'TemplateLiteral[expressions.length>0][quasis.0.value.raw*="INSERT"]',
          message: 'Potential SQL injection: Avoid template literals with variables in INSERT statements. Use parameterized queries instead.'
        },
        {
          selector: 'TemplateLiteral[expressions.length>0][quasis.0.value.raw*="UPDATE"]',
          message: 'Potential SQL injection: Avoid template literals with variables in UPDATE statements. Use parameterized queries instead.'
        },
        {
          selector: 'TemplateLiteral[expressions.length>0][quasis.0.value.raw*="DELETE"]',
          message: 'Potential SQL injection: Avoid template literals with variables in DELETE statements. Use parameterized queries instead.'
        },
        {
          selector: 'TemplateLiteral[expressions.length>0][quasis.0.value.raw*="ORDER BY"]',
          message: 'Potential SQL injection: Avoid template literals with variables in ORDER BY clauses. Use allowlisted columns instead.'
        },
        {
          selector: 'BinaryExpression[operator="+"][left.type="Literal"][left.value*="SELECT"]',
          message: 'Potential SQL injection: Avoid string concatenation in SELECT statements. Use parameterized queries instead.'
        },
        {
          selector: 'BinaryExpression[operator="+"][left.type="Literal"][left.value*="INSERT"]',
          message: 'Potential SQL injection: Avoid string concatenation in INSERT statements. Use parameterized queries instead.'
        },
        {
          selector: 'BinaryExpression[operator="+"][left.type="Literal"][left.value*="UPDATE"]',
          message: 'Potential SQL injection: Avoid string concatenation in UPDATE statements. Use parameterized queries instead.'
        },
        {
          selector: 'BinaryExpression[operator="+"][left.type="Literal"][left.value*="DELETE"]',
          message: 'Potential SQL injection: Avoid string concatenation in DELETE statements. Use parameterized queries instead.'
        }
      ]
    },
  },
);
