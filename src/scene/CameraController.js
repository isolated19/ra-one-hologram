import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// The framed subject: head, neck and upper shoulders (world units)
const FRAME = { centerY: 0.6, halfHeight: 1.85, halfWidth: 1.9 };
const MAX_AZIMUTH = THREE.MathUtils.degToRad(20);
const POLAR_RANGE = THREE.MathUtils.degToRad(8);

/**
 * Frontal portrait with a small orbit range (±20° horizontally, ±8° vertically)
 * — enough parallax to separate the particle layers without losing the face.
 * fit() picks the distance from the viewport aspect so the figure is never
 * cropped, and shifts the image so it sits in the space the UI leaves free.
 */
export class CameraController {
  constructor(camera, domElement) {
    this.camera = camera;
    this.distance = 9;
    this.camera.position.set(0, FRAME.centerY + 0.25, this.distance);

    this.controls = new OrbitControls(camera, domElement);
    this.controls.target.set(0, FRAME.centerY, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.enablePan = false;
    this.controls.rotateSpeed = 0.45;
    this.controls.zoomSpeed = 0.5;
    this.controls.minAzimuthAngle = -MAX_AZIMUTH;
    this.controls.maxAzimuthAngle = MAX_AZIMUTH;
    this.controls.minPolarAngle = Math.PI / 2 - POLAR_RANGE;
    this.controls.maxPolarAngle = Math.PI / 2 + POLAR_RANGE * 0.6;
    this.controls.update();
  }

  /**
   * @param {number} width  viewport width in CSS px
   * @param {number} height viewport height in CSS px
   * @param {{top: number, bottom: number}} insets CSS px covered by UI at the top and bottom
   */
  fit(width, height, insets = { top: 0, bottom: 0 }) {
    const avail = Math.max(120, height - insets.top - insets.bottom);
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const aspect = width / height;
    // Fit the frame height into the free band, and the width into the full width
    const byHeight = (FRAME.halfHeight * (height / avail)) / tanHalf;
    const byWidth = FRAME.halfWidth / (tanHalf * aspect);
    const distance = Math.max(byHeight, byWidth) * 1.04;

    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.camera.position.copy(this.controls.target).addScaledVector(dir, distance);
    this.controls.minDistance = distance * 0.85;
    this.controls.maxDistance = distance * 1.2;
    this.distance = distance;

    // Centre the figure in the free band, not the full window
    const shift = (insets.bottom - insets.top) / 2;
    this.camera.setViewOffset(width, height, 0, shift, width, height);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  get currentDistance() {
    return this.camera.position.distanceTo(this.controls.target);
  }

  update() {
    this.controls.update();
  }
}
