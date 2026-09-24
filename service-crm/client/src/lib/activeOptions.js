// Labels an inactive (deactivated) technician/staff option for a filter
// dropdown, so a name that's still selectable for historical filtering
// clearly reads as no longer active — never used for an assignment dropdown,
// which excludes inactive people entirely rather than labeling them.
export function withInactiveLabel(options) {
  return options.map((o) => ({ ...o, name: o.active ? o.name : `${o.name} (inactive)` }));
}
