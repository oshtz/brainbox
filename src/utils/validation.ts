// Data validation utilities
export interface ValidationRule<T = unknown> {
  validate: (value: T) => boolean;
  message: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

export class Validator<T = unknown> {
  private rules: ValidationRule<T>[] = [];

  constructor(rules: ValidationRule<T>[] = []) {
    this.rules = rules;
  }

  addRule(rule: ValidationRule<T>): Validator<T> {
    this.rules.push(rule);
    return this;
  }

  validate(value: T): ValidationResult {
    const errors: string[] = [];

    for (const rule of this.rules) {
      if (!rule.validate(value)) {
        errors.push(rule.message);
      }
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }
}

// Common validation rules
export const ValidationRules = {
  required: <T = unknown>(message: string = 'This field is required'): ValidationRule<T> => ({
    validate: (value: T) => {
      if (value === null || value === undefined) return false;
      if (typeof value === 'string') return value.trim().length > 0;
      if (Array.isArray(value)) return value.length > 0;
      return true;
    },
    message
  }),

  minLength: (min: number, message?: string): ValidationRule<string> => ({
    validate: (value: string) => {
      if (typeof value !== 'string') return false;
      return value.length >= min;
    },
    message: message || `Must be at least ${min} characters long`
  }),

  maxLength: (max: number, message?: string): ValidationRule<string> => ({
    validate: (value: string) => {
      if (typeof value !== 'string') return false;
      return value.length <= max;
    },
    message: message || `Must be no more than ${max} characters long`
  }),

  email: (message: string = 'Must be a valid email address'): ValidationRule<string> => ({
    validate: (value: string) => {
      if (typeof value !== 'string') return false;
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      return emailRegex.test(value);
    },
    message
  }),

  url: (message: string = 'Must be a valid URL'): ValidationRule<string> => ({
    validate: (value: string) => {
      if (typeof value !== 'string') return false;
      try {
        const url = new URL(value);
        // Only allow http and https protocols
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    },
    message
  }),

  pattern: (regex: RegExp, message: string): ValidationRule<string> => ({
    validate: (value: string) => {
      if (typeof value !== 'string') return false;
      return regex.test(value);
    },
    message
  }),

  custom: <T = unknown>(validator: (value: T) => boolean, message: string): ValidationRule<T> => ({
    validate: validator,
    message
  })
};

// Data sanitization utilities
export const sanitize = {
  string: (value: unknown): string => {
    if (typeof value === 'string') return value.trim();
    if (value === null || value === undefined) return '';
    return String(value).trim();
  },

  html: (value: string): string => {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/\//g, '&#x2F;');
  },

  url: (value: string): string => {
    const sanitized = sanitize.string(value);
    if (!sanitized) return '';
    
    // Add protocol if missing
    if (!/^https?:\/\//i.test(sanitized)) {
      return `https://${sanitized}`;
    }
    
    return sanitized;
  },

  filename: (value: string): string => {
    return sanitize.string(value)
      .replace(/[<>:"/\\|?*]/g, '') // Remove invalid filename characters
      .replace(/\s+/g, ' ') // Normalize whitespace
      .substring(0, 255); // Limit length
  },

  alphanumeric: (value: string): string => {
    return sanitize.string(value).replace(/[^a-zA-Z0-9]/g, '');
  },

  slug: (value: string): string => {
    return sanitize.string(value)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/-+/g, '-') // Remove duplicate hyphens
      .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
  }
};

// Specific validators for brainbox entities
export const VaultValidators = {
  name: new Validator<string>([
    ValidationRules.required('Vault name is required'),
    ValidationRules.minLength(1, 'Vault name cannot be empty'),
    ValidationRules.maxLength(100, 'Vault name must be less than 100 characters')
  ]),

  password: new Validator<string>([
    ValidationRules.required('Password is required'),
    ValidationRules.minLength(8, 'Password must be at least 8 characters long'),
    ValidationRules.pattern(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
      'Password must contain at least one lowercase letter, one uppercase letter, and one number'
    )
  ])
};

export const ItemValidators = {
  title: new Validator<string>([
    ValidationRules.required('Title is required'),
    ValidationRules.minLength(1, 'Title cannot be empty'),
    ValidationRules.maxLength(200, 'Title must be less than 200 characters')
  ]),

  content: new Validator<string>([
    ValidationRules.required('Content is required'),
    ValidationRules.minLength(1, 'Content cannot be empty'),
    ValidationRules.maxLength(50000, 'Content must be less than 50,000 characters')
  ]),

  url: new Validator<string>([
    ValidationRules.url('Must be a valid URL')
  ])
};

// Utility function to validate and sanitize form data
type ValidatorMap<T extends Record<string, unknown>> = {
  [K in keyof T]: Validator<T[K]>;
};

type SanitizerMap<T extends Record<string, unknown>> = Partial<{
  [K in keyof T]: (value: T[K]) => T[K];
}>;

export const validateAndSanitize = <T extends Record<string, unknown>>(
  data: T,
  validators: ValidatorMap<T>,
  sanitizers?: SanitizerMap<T>
): { isValid: boolean; errors: Partial<Record<keyof T, string[]>>; sanitized: T } => {
  const errors: Partial<Record<keyof T, string[]>> = {};
  const sanitized = { ...data } as T;
  let isValid = true;

  for (const key of Object.keys(validators) as Array<keyof T>) {
    const validator = validators[key];
    const value = sanitized[key];

    const sanitizer = sanitizers?.[key];
    if (sanitizer) {
      sanitized[key] = sanitizer(value);
    }

    const result = validator.validate(sanitized[key]);
    if (!result.isValid) {
      errors[key] = result.errors;
      isValid = false;
    }
  }

  return { isValid, errors, sanitized };
};
