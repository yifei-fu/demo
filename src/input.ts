/** The one smoothed input state every sensor writes into and the navigator reads from. */

export interface Stir {
  active: boolean;
  /** touch position and velocity in NDC (x right, y up; velocity in NDC units per second) */
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface Input {
  /** Bead drive in screen space (x right, y up), ~25 deg of tilt = 1, dead-zoned and smoothed. */
  tilt: [number, number];
  /** Holographic parallax offset, roughly [-1, 1] each. */
  parallax: [number, number];
  /** Body heading relative to the start, radians, unwrapped; turning right increases it. */
  yaw: number;
  /** Desktop drag orbit offsets, radians. */
  orbitYaw: number;
  orbitPitch: number;
  /** A touch has been held still: dive while true. */
  hold: boolean;
  /** Manual dive target from the wheel, 0..1. */
  dive: number;
  stir: Stir;
  /** Pinch/zoom delta accumulated since the previous frame (relative distance change). */
  pinch: number;
  /** True for the frame in which a shake impulse fired. */
  shake: boolean;
  /** True for the frame in which the map key was pressed. */
  map: boolean;
  /** True on any frame with real human input; cancels the idle autopilot. */
  active: boolean;
}

export function createInput(): Input {
  return {
    tilt: [0, 0],
    parallax: [0, 0],
    yaw: 0,
    orbitYaw: 0,
    orbitPitch: 0,
    hold: false,
    dive: 0,
    stir: { active: false, x: 0, y: 0, vx: 0, vy: 0 },
    pinch: 0,
    shake: false,
    map: false,
    active: false,
  };
}
