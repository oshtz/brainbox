import { describe, it, expect } from 'vitest';
import { 
  Validator, 
  ValidationRules, 
  sanitize, 
  VaultValidators, 
  ItemValidators,
  validateAndSanitize 
} from './validation';

describe('Validation Utilities', () => {
  describe('Validator Class', () => {
    it('validates with no rules', () => {
      const validator = new Validator();
      const result = validator.validate('test');
      
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('validates with single rule', () => {
      const validator = new Validator<string>([
        ValidationRules.required('Field is required')
      ]);
      
      expect(validator.validate('test').isValid).toBe(true);
      expect(validator.validate('').isValid).toBe(false);
      expect(validator.validate('').errors).toEqual(['Field is required']);
    });

    it('validates with multiple rules', () => {
      const validator = new Validator<string>([
        ValidationRules.required(),
        ValidationRules.minLength(5)
      ]);
      
      expect(validator.validate('hello').isValid).toBe(true);
      expect(validator.validate('hi').isValid).toBe(false);
      expect(validator.validate('hi').errors).toHaveLength(1);
      expect(validator.validate('').errors).toHaveLength(2);
    });

    it('can add rules dynamically', () => {
      const validator = new Validator<string>()
        .addRule(ValidationRules.required())
        .addRule(ValidationRules.maxLength(10));
      
      expect(validator.validate('test').isValid).toBe(true);
      expect(validator.validate('').isValid).toBe(false);
      expect(validator.validate('this is too long').isValid).toBe(false);
    });
  });

  describe('ValidationRules', () => {
    describe('required', () => {
      const rule = ValidationRules.required();

      it('validates non-empty strings', () => {
        expect(rule.validate('test')).toBe(true);
        expect(rule.validate('  test  ')).toBe(true);
      });

      it('rejects empty values', () => {
        expect(rule.validate('')).toBe(false);
        expect(rule.validate('   ')).toBe(false);
        expect(rule.validate(null)).toBe(false);
        expect(rule.validate(undefined)).toBe(false);
      });

      it('validates arrays', () => {
        expect(rule.validate([1, 2, 3])).toBe(true);
        expect(rule.validate([])).toBe(false);
      });
    });

    describe('minLength', () => {
      const rule = ValidationRules.minLength(5);

      it('validates strings meeting minimum length', () => {
        expect(rule.validate('hello')).toBe(true);
        expect(rule.validate('hello world')).toBe(true);
      });

      it('rejects strings below minimum length', () => {
        expect(rule.validate('hi')).toBe(false);
        expect(rule.validate('')).toBe(false);
      });

      it('rejects non-strings', () => {
        expect(rule.validate(123 as unknown as string)).toBe(false);
        expect(rule.validate(null as unknown as string)).toBe(false);
      });
    });

    describe('maxLength', () => {
      const rule = ValidationRules.maxLength(10);

      it('validates strings within maximum length', () => {
        expect(rule.validate('hello')).toBe(true);
        expect(rule.validate('1234567890')).toBe(true);
      });

      it('rejects strings exceeding maximum length', () => {
        expect(rule.validate('this is too long')).toBe(false);
      });
    });

    describe('email', () => {
      const rule = ValidationRules.email();

      it('validates correct email formats', () => {
        expect(rule.validate('test@example.com')).toBe(true);
        expect(rule.validate('user.name+tag@domain.co.uk')).toBe(true);
      });

      it('rejects invalid email formats', () => {
        expect(rule.validate('invalid-email')).toBe(false);
        expect(rule.validate('test@')).toBe(false);
        expect(rule.validate('@example.com')).toBe(false);
        expect(rule.validate('test@example')).toBe(false);
      });
    });

    describe('url', () => {
      const rule = ValidationRules.url();

      it('validates correct URL formats', () => {
        expect(rule.validate('https://example.com')).toBe(true);
        expect(rule.validate('http://localhost:3000')).toBe(true);
        expect(rule.validate('https://sub.domain.com/path?query=1')).toBe(true);
      });

      it('rejects invalid URL formats', () => {
        expect(rule.validate('not-a-url')).toBe(false);
        expect(rule.validate('ftp://example.com')).toBe(false);
        expect(rule.validate('example.com')).toBe(false);
      });
    });

    describe('pattern', () => {
      const rule = ValidationRules.pattern(/^\d+$/, 'Must be numbers only');

      it('validates strings matching pattern', () => {
        expect(rule.validate('123')).toBe(true);
        expect(rule.validate('0')).toBe(true);
      });

      it('rejects strings not matching pattern', () => {
        expect(rule.validate('abc')).toBe(false);
        expect(rule.validate('123abc')).toBe(false);
      });
    });

    describe('custom', () => {
      const rule = ValidationRules.custom(
        (value: number) => value > 0,
        'Must be positive'
      );

      it('validates using custom function', () => {
        expect(rule.validate(5)).toBe(true);
        expect(rule.validate(-1)).toBe(false);
      });
    });
  });

  describe('Sanitization', () => {
    describe('string', () => {
      it('trims whitespace from strings', () => {
        expect(sanitize.string('  hello  ')).toBe('hello');
      });

      it('converts non-strings to strings', () => {
        expect(sanitize.string(123)).toBe('123');
        expect(sanitize.string(null)).toBe('');
        expect(sanitize.string(undefined)).toBe('');
      });
    });

    describe('html', () => {
      it('escapes HTML characters', () => {
        expect(sanitize.html('<script>alert("xss")</script>'))
          .toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;&#x2F;script&gt;');
        
        expect(sanitize.html('Hello & "World"'))
          .toBe('Hello &amp; &quot;World&quot;');
      });
    });

    describe('url', () => {
      it('adds https protocol when missing', () => {
        expect(sanitize.url('example.com')).toBe('https://example.com');
        expect(sanitize.url('www.example.com')).toBe('https://www.example.com');
      });

      it('preserves existing protocol', () => {
        expect(sanitize.url('http://example.com')).toBe('http://example.com');
        expect(sanitize.url('https://example.com')).toBe('https://example.com');
      });

      it('handles empty strings', () => {
        expect(sanitize.url('')).toBe('');
        expect(sanitize.url('   ')).toBe('');
      });
    });

    describe('filename', () => {
      it('removes invalid filename characters', () => {
        expect(sanitize.filename('file<>:"/\\|?*name.txt'))
          .toBe('filename.txt');
      });

      it('normalizes whitespace', () => {
        expect(sanitize.filename('file   name.txt'))
          .toBe('file name.txt');
      });

      it('limits length', () => {
        const longName = 'a'.repeat(300);
        expect(sanitize.filename(longName)).toHaveLength(255);
      });
    });

    describe('slug', () => {
      it('creates URL-friendly slugs', () => {
        expect(sanitize.slug('Hello World!')).toBe('hello-world');
        expect(sanitize.slug('  Multiple   Spaces  ')).toBe('multiple-spaces');
        expect(sanitize.slug('Special@#$Characters')).toBe('specialcharacters');
      });

      it('removes leading and trailing hyphens', () => {
        expect(sanitize.slug('-hello-world-')).toBe('hello-world');
      });

      it('removes duplicate hyphens', () => {
        expect(sanitize.slug('hello---world')).toBe('hello-world');
      });
    });
  });

  describe('Predefined Validators', () => {
    describe('VaultValidators', () => {
      it('validates vault names', () => {
        expect(VaultValidators.name.validate('My Vault').isValid).toBe(true);
        expect(VaultValidators.name.validate('').isValid).toBe(false);
        expect(VaultValidators.name.validate('a'.repeat(101)).isValid).toBe(false);
      });

      it('validates vault passwords', () => {
        expect(VaultValidators.password.validate('Password123').isValid).toBe(true);
        expect(VaultValidators.password.validate('weak').isValid).toBe(false);
        expect(VaultValidators.password.validate('nouppercaseornumber').isValid).toBe(false);
      });
    });

    describe('ItemValidators', () => {
      it('validates item titles', () => {
        expect(ItemValidators.title.validate('My Item').isValid).toBe(true);
        expect(ItemValidators.title.validate('').isValid).toBe(false);
        expect(ItemValidators.title.validate('a'.repeat(201)).isValid).toBe(false);
      });

      it('validates item content', () => {
        expect(ItemValidators.content.validate('Some content').isValid).toBe(true);
        expect(ItemValidators.content.validate('').isValid).toBe(false);
        expect(ItemValidators.content.validate('a'.repeat(50001)).isValid).toBe(false);
      });

      it('validates URLs', () => {
        expect(ItemValidators.url.validate('https://example.com').isValid).toBe(true);
        expect(ItemValidators.url.validate('not-a-url').isValid).toBe(false);
      });
    });
  });

  describe('validateAndSanitize', () => {
    it('validates and sanitizes form data', () => {
      const data = {
        name: '  Test Name  ',
        email: 'test@example.com',
        age: 25
      };

      const validators = {
        name: new Validator<string>([ValidationRules.required(), ValidationRules.minLength(2)]),
        email: new Validator<string>([ValidationRules.email()]),
        age: new Validator<number>([ValidationRules.custom((val: number) => val >= 18, 'Must be 18+')])
      };

      const sanitizers = {
        name: sanitize.string,
        email: sanitize.string,
        age: (val: unknown) => val as number
      };

      const result = validateAndSanitize(data, validators, sanitizers);

      expect(result.isValid).toBe(true);
      expect(result.sanitized.name).toBe('Test Name');
      expect(result.errors).toEqual({});
    });

    it('returns validation errors', () => {
      const data = {
        name: '',
        email: 'invalid-email'
      };

      const validators = {
        name: new Validator<string>([ValidationRules.required()]),
        email: new Validator<string>([ValidationRules.email()])
      };

      const result = validateAndSanitize(data, validators);

      expect(result.isValid).toBe(false);
      expect(result.errors.name).toContain('This field is required');
      expect(result.errors.email).toContain('Must be a valid email address');
    });
  });
});
