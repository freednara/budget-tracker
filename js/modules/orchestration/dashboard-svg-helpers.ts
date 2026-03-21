/**
 * Dashboard SVG Helpers
 * 
 * SVG utility functions extracted from dashboard module
 * to improve modularity and reusability.
 * 
 * @module dashboard-svg-helpers
 */

// ==========================================
// SVG PATH HELPERS
// ==========================================

/**
 * Helper function to describe SVG arc path
 */
export function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const x1 = cx + r * Math.cos(startAngle);
  const y1 = cy - r * Math.sin(startAngle);
  const x2 = cx + r * Math.cos(endAngle);
  const y2 = cy - r * Math.sin(endAngle);
  const largeArc = Math.abs(endAngle - startAngle) >= Math.PI ? 1 : 0;
  const sweep = startAngle > endAngle ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} ${sweep} ${x2} ${y2}`;
}

/**
 * Create a circular progress path
 */
export function createCircularProgress(
  cx: number,
  cy: number,
  radius: number,
  progress: number,
  startAngle = -Math.PI / 2
): string {
  const endAngle = startAngle + (2 * Math.PI * progress);
  return describeArc(cx, cy, radius, startAngle, endAngle);
}

/**
 * Create a donut chart path segment
 */
export function createDonutSegment(
  cx: number,
  cy: number,
  innerRadius: number,
  outerRadius: number,
  startAngle: number,
  endAngle: number
): string {
  const innerArc = describeArc(cx, cy, innerRadius, startAngle, endAngle);
  const outerArc = describeArc(cx, cy, outerRadius, endAngle, startAngle);
  return `${innerArc} L ${cx + outerRadius * Math.cos(endAngle)} ${cy - outerRadius * Math.sin(endAngle)} ${outerArc} Z`;
}

/**
 * Convert percentage to radians for circular charts
 */
export function percentToRadians(percent: number, startAngle = -Math.PI / 2): number {
  return startAngle + (2 * Math.PI * percent / 100);
}

/**
 * Get point on circle for given angle and radius
 */
export function getCirclePoint(cx: number, cy: number, radius: number, angle: number): { x: number; y: number } {
  return {
    x: cx + radius * Math.cos(angle),
    y: cy - radius * Math.sin(angle)
  };
}