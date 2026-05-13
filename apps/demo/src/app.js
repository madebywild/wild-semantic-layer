export function describeSemanticLayer() {
  return "Semantic layer demo: docs compile against live source symbols.";
}

export function runtimeName() {
  return "Node.js 24";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(describeSemanticLayer());
}
