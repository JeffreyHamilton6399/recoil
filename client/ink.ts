// The hand-drawn look: the scene is rendered into a texture, then a full-
// screen pass inks it like a comic panel.
//  - Ink lines wherever depth jumps (silhouettes, creases) or colour changes
//    sharply, thinning out into the distance so the far city stays soft.
//  - The lines "boil": they wobble by a pixel or so, 12 times a second, like
//    hand-drawn animation redrawn every other frame.
//  - Pencil hatching in the shadows, cross-hatched in the darkest parts.
//  - Paper grain over everything.

import * as THREE from 'three';

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform vec2 resolution;
  uniform float cameraNear;
  uniform float cameraFar;
  uniform float boil;
  uniform float lineScale;
  uniform vec3 inkColor;
  varying vec2 vUv;

  float linearDepth(vec2 uv) {
    float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
    return (2.0 * cameraNear * cameraFar) / (cameraFar + cameraNear - z * (cameraFar - cameraNear));
  }

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  float luma(vec3 c) {
    return dot(c, vec3(0.299, 0.587, 0.114));
  }

  void main() {
    vec2 px = 1.0 / resolution;
    vec2 fc = vUv * resolution;

    // Boiling lines: sample the edges from a slightly wobbled position.
    vec2 wobble = (vec2(noise(fc / 22.0 + boil), noise(fc / 22.0 + boil + 17.3)) - 0.5) * 2.4 * px * lineScale;
    vec2 uv = vUv + wobble;
    float w = 1.25 * lineScale;

    float d = linearDepth(uv);
    float dl = linearDepth(uv - vec2(px.x * w, 0.0));
    float dr = linearDepth(uv + vec2(px.x * w, 0.0));
    float du = linearDepth(uv + vec2(0.0, px.y * w));
    float dd = linearDepth(uv - vec2(0.0, px.y * w));
    // Relative jumps, so near and far objects get similar lines.
    float nearest = min(d, min(min(dl, dr), min(du, dd)));
    float depthEdge = (abs(dl - d) + abs(dr - d) + abs(du - d) + abs(dd - d)) / max(nearest, 0.3);
    float ink = smoothstep(0.06, 0.16, depthEdge);

    vec3 cl = texture2D(tColor, uv - vec2(px.x * w, 0.0)).rgb;
    vec3 cr = texture2D(tColor, uv + vec2(px.x * w, 0.0)).rgb;
    vec3 cu = texture2D(tColor, uv + vec2(0.0, px.y * w)).rgb;
    vec3 cd = texture2D(tColor, uv - vec2(0.0, px.y * w)).rgb;
    float colorEdge = abs(luma(cl) - luma(cr)) + abs(luma(cu) - luma(cd));
    ink = max(ink, smoothstep(0.3, 0.7, colorEdge) * 0.55);

    // Lines fade out into the haze; nothing is drawn on the sky itself.
    ink *= 1.0 - smoothstep(90.0, 380.0, nearest);

    gl_FragColor = vec4(texture2D(tColor, vUv).rgb, 1.0);
    #include <tonemapping_fragment>
    vec3 col = gl_FragColor.rgb;

    // Pencil hatching in the shadows (not on the sky).
    float sky = step(900.0, d);
    float L = luma(col);
    float hatchA = 1.0 - smoothstep(0.0, 1.1, abs(fract((fc.x + fc.y) / (6.0 * lineScale)) - 0.5) * 6.0 * lineScale);
    float hatchB = 1.0 - smoothstep(0.0, 1.1, abs(fract((fc.x - fc.y) / (6.0 * lineScale)) - 0.5) * 6.0 * lineScale);
    float shade = smoothstep(0.24, 0.07, L) * 0.3 * hatchA + smoothstep(0.1, 0.02, L) * 0.3 * hatchB;
    float jitter = 0.75 + 0.5 * noise(fc / 9.0 + boil * 0.5);
    col = mix(col, inkColor, shade * jitter * (1.0 - sky) * (1.0 - smoothstep(60.0, 200.0, d)));

    // Paper grain and a warm printed tint.
    float grain = noise(fc * 0.9) * 0.6 + noise(fc * 0.23) * 0.4;
    col *= 0.93 + 0.07 * grain;
    col = mix(col, col * vec3(1.03, 1.0, 0.94), 0.5);

    col = mix(col, inkColor, clamp(ink, 0.0, 1.0) * 0.92);
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export class Inker {
  private readonly target: THREE.WebGLRenderTarget;
  private readonly quad: THREE.Mesh;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;
  private boilTime = 0;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    const depthTexture = new THREE.DepthTexture(1, 1);
    depthTexture.type = THREE.UnsignedIntType;
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: 4,
      depthTexture,
    });
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tColor: { value: this.target.texture },
        tDepth: { value: depthTexture },
        resolution: { value: new THREE.Vector2(1, 1) },
        cameraNear: { value: 0.05 },
        cameraFar: { value: 2000 },
        boil: { value: 0 },
        lineScale: { value: 1 },
        inkColor: { value: new THREE.Color('#1b1030') },
      },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    const w = Math.max(1, Math.floor(width * pixelRatio));
    const h = Math.max(1, Math.floor(height * pixelRatio));
    this.target.setSize(w, h);
    this.material.uniforms.resolution.value.set(w, h);
    // Lines stay about the same thickness on high-DPI screens.
    this.material.uniforms.lineScale.value = Math.max(1, pixelRatio * 0.85);
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, dt: number): void {
    // Redraw the wobble 12 times a second ("on twos").
    this.boilTime += dt;
    const u = this.material.uniforms;
    u.boil.value = Math.floor(this.boilTime * 12) * 3.17;
    u.cameraNear.value = camera.near;
    u.cameraFar.value = camera.far;
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.quadCamera);
  }
}
