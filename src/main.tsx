import "./legacyRuntime";

// Resolve one edition at build time. Dynamic evaluation keeps compatibility
// patches ahead of every React/application module on older TV WebViews.
void import("@edition-bootstrap");
