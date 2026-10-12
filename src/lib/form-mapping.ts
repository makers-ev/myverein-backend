/**
 * Allowlist of the `club_members` master data a form field may be written to on acceptance (Wave 8, ADR-005).
 * Never a free column name (mass assignment): a field either maps to one of these targets, to a custom field
 * (`customField`), or stays a pure answer. Each target lists the field types that can carry its value.
 */
export const MAPPING_TARGETS = {
  firstName: ["text"],
  lastName: ["text"],
  birthDate: ["date"],
  street: ["text"],
  postalCode: ["text"],
  city: ["text"],
  phone: ["text"],
  contactEmail: ["text"],
  emergencyContactName: ["text"],
  emergencyContactPhone: ["text"],
  category: ["select"],
  photo: ["image"],
} as const;

export type MappingTarget = keyof typeof MAPPING_TARGETS;

export const MAPPING_TARGET_KEYS = Object.keys(MAPPING_TARGETS) as [MappingTarget, ...MappingTarget[]];

export function isMappingTarget(value: unknown): value is MappingTarget {
  return typeof value === "string" && Object.hasOwn(MAPPING_TARGETS, value);
}

export function mappingAcceptsType(target: MappingTarget, fieldType: string): boolean {
  return (MAPPING_TARGETS[target] as readonly string[]).includes(fieldType);
}
