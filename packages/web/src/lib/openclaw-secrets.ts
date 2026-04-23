export type SecretRef = {
  source: "file";
  provider: "pinchy";
  id: string;
};

export function secretRef(id: string): SecretRef {
  return { source: "file", provider: "pinchy", id };
}
