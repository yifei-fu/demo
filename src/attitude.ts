/**
 * Device attitude maths (pure functions).
 *
 * deviceorientation gives Z-X'-Y'' Euler angles: R = Rz(alpha) Rx(beta) Ry(gamma) maps device
 * axes to earth axes (x east, y north, z up). Everything below is derived from R so that it stays
 * well-defined in the upright pose, where the Euler angles themselves are near gimbal lock.
 */

const DEG = Math.PI / 180;

export interface Pose {
  /** Angle of gravity about the screen's x axis: 0 flat, +90 deg upright. Top away => decreases. */
  pitch: number;
  /** Angle of gravity about the screen's y axis: right edge down => positive. */
  roll: number;
  /** Direction the screen faces, in earth frame (counter-clockwise from east, radians). */
  heading: number;
  /** Horizontal length of the heading vector; small when the direction is ill-defined. */
  headingConfidence: number;
}

type Vec3 = [number, number, number];

/** Screen x/y axes expressed in device coordinates for a given screen.orientation.angle. */
function screenAxes(angleDeg: number): { x: Vec3; y: Vec3 } {
  switch (((Math.round(angleDeg / 90) % 4) + 4) % 4) {
    case 1:
      return { x: [0, -1, 0], y: [1, 0, 0] };
    case 2:
      return { x: [-1, 0, 0], y: [0, -1, 0] };
    case 3:
      return { x: [0, 1, 0], y: [-1, 0, 0] };
    default:
      return { x: [1, 0, 0], y: [0, 1, 0] };
  }
}

export function poseFromEuler(
  alphaDeg: number,
  betaDeg: number,
  gammaDeg: number,
  screenAngleDeg: number,
): Pose {
  const a = alphaDeg * DEG;
  const b = betaDeg * DEG;
  const g = gammaDeg * DEG;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const cb = Math.cos(b);
  const sb = Math.sin(b);
  const cg = Math.cos(g);
  const sg = Math.sin(g);

  // rows of R (earth <- device)
  const R: [Vec3, Vec3, Vec3] = [
    [ca * cg - sa * sb * sg, -cb * sa, cg * sa * sb + ca * sg],
    [cg * sa + ca * sb * sg, ca * cb, sa * sg - ca * cg * sb],
    [-cb * sg, sb, cb * cg],
  ];
  const { x: sx, y: sy } = screenAxes(screenAngleDeg);
  const dot = (u: Vec3, v: Vec3): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];

  // earth-up in device coordinates is the third row of R; project onto screen axes
  const up = R[2];
  const ux = dot(up, sx);
  const uy = dot(up, sy);
  const uz = up[2];
  const pitch = Math.atan2(uy, uz);
  const roll = Math.atan2(-ux, Math.hypot(uy, uz));

  // Screen faces -z_device. Add the horizontal parts of that and of the screen's up axis: for an
  // upright phone the first is well-defined, for a flat one the second; in between they agree.
  const yEarth: Vec3 = [dot(R[0], sy), dot(R[1], sy), dot(R[2], sy)];
  const hx = -R[0][2] + yEarth[0];
  const hy = -R[1][2] + yEarth[1];
  return { pitch, roll, heading: Math.atan2(hy, hx), headingConfidence: Math.hypot(hx, hy) };
}

export const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** Rest-relative tilt in screen coordinates: x right, y up, normalised so `fullDeg` = 1. */
export function tiltFromPose(pose: Pose, rest: Pose, fullDeg = 25): [number, number] {
  const k = 1 / (fullDeg * DEG);
  return [wrapAngle(pose.roll - rest.roll) * k, wrapAngle(rest.pitch - pose.pitch) * k];
}

/** Dead zone on the vector length, rescaled so the output still reaches 1 at full tilt. */
export function deadZone(x: number, y: number, zone: number): [number, number] {
  const m = Math.hypot(x, y);
  if (m <= zone) return [0, 0];
  const k = (m - zone) / (1 - zone) / m;
  return [x * k, y * k];
}
