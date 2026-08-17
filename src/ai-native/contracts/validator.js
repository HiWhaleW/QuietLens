import Ajv from "ajv";

import { CONTRACT_SCHEMAS } from "./schemas.js";

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
const validators = new Map(
  Object.entries(CONTRACT_SCHEMAS).map(([name, schema]) => [name, ajv.compile(schema)]),
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
