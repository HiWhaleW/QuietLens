import { CONTRACT_SCHEMAS } from "./schemas.js";
import * as generatedValidators from "./generatedValidators.js";

const validators = new Map(
  Object.keys(CONTRACT_SCHEMAS).map((name) => [name, generatedValidators[name]]),
);

function normalizeErrors(errors = []) {
  return errors.map((error) => ({
    instance_path: error.instancePath || "/",
    keyword: error.keyword,
    message: error.message,
    params: error.params,
  }));
}

export function validateContract(name, value) {
  const validator = validators.get(name);
  if (!validator) {
    throw new Error(`Unknown QuietLens contract: ${name}`);
  }

  const valid = validator(value);
  return {
    valid: Boolean(valid),
    errors: valid ? [] : normalizeErrors(validator.errors),
  };
}

export function assertContract(name, value, label = name) {
  const result = validateContract(name, value);
  if (!result.valid) {
    const detail = result.errors
      .map((error) => `${error.instance_path} ${error.message}`)
      .join("; ");
    throw new Error(`${label} failed ${name} validation: ${detail}`);
  }
  return value;
}
