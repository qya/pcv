import type { DecodedFrame } from "../../shared/format";
import type { PointRenderer } from "./PointRenderer";

export type RenderMode = "normal" | "neon" | "matrix" | "wireframe";

export type RendererOptions = {
  canvas: HTMLCanvasElement;
  pointSize?: number;
  glow?: boolean;
};
// ... rest of shader constants ...
const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec4 a_color;

uniform float u_pointSize;

out vec4 v_color;

void main() {
  vec2 clip = vec2(a_position.x * 2.0 - 1.0, 1.0 - a_position.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  gl_PointSize = u_pointSize;
  v_color = a_color;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec4 v_color;
uniform int u_mode;
uniform bool u_glow;

out vec4 outColor;

void main() {
  vec2 center = gl_PointCoord - vec2(0.5);
  float distanceFromCenter = length(center);
  float soft = 1.0;
  vec3 color = v_color.rgb;

  if (u_mode == 1) {
    if (distanceFromCenter > 0.5) discard;
    soft = smoothstep(0.5, 0.05, distanceFromCenter);
    color = min(vec3(1.0), color * vec3(0.6, 1.2, 1.8) + vec3(0.08, 0.2, 0.35));
  } else if (u_mode == 2) {
    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    color = vec3(0.05, max(0.22, luma), 0.08);
  } else if (u_mode == 3) {
    float edge = smoothstep(0.32, 0.5, distanceFromCenter);
    color = mix(vec3(0.0), color, edge);
    soft = edge;
  }

  if (u_glow) {
    color += color * (1.0 - distanceFromCenter) * 0.55;
  }

  outColor = vec4(color, soft * v_color.a);
}`;

const TEXTURE_VERTEX_SHADER = `#version 300 es
const vec2 POSITIONS[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2(3.0, -1.0),
  vec2(-1.0, 3.0)
);

out vec2 v_uv;

void main() {
  vec2 position = POSITIONS[gl_VertexID];
  gl_Position = vec4(position, 0.0, 1.0);
  v_uv = position * 0.5 + 0.5;
}`;

const TEXTURE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_uv;
uniform sampler2D u_frame;
uniform int u_mode;

out vec4 outColor;

void main() {
  vec4 color = texture(u_frame, vec2(v_uv.x, 1.0 - v_uv.y));
  if (u_mode == 1) {
    color.rgb = min(vec3(1.0), color.rgb * vec3(0.65, 1.15, 1.75) + vec3(0.04, 0.13, 0.2));
  } else if (u_mode == 2) {
    float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
    color.rgb = vec3(0.03, max(0.18, luma), 0.06);
  }
  outColor = vec4(color.rgb, 1.0);
}`;

export class WebGLPointRenderer implements PointRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly textureProgram: WebGLProgram;
  private readonly buffer: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly texture: WebGLTexture;
  private readonly pointSizeLocation: WebGLUniformLocation;
  private readonly modeLocation: WebGLUniformLocation;
  private readonly glowLocation: WebGLUniformLocation;
  private readonly textureModeLocation: WebGLUniformLocation;
  private pointSize: number | null;
  private sourceWidth = 160;
  private sourceHeight = 90;
  private textureWidth = 0;
  private textureHeight = 0;
  private textureFormat: "rgba" | "rgb565" | null = null;
  private lastParticleCount = 0;
  private mode: RenderMode = "normal";
  private glow: boolean;

  constructor(options: RendererOptions) {
    const gl = options.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      powerPreference: "high-performance"
    });

    if (!gl) {
      throw new Error("WebGL2 is required for Point Cloud Video playback.");
    }

    this.gl = gl;
    this.pointSize = options.pointSize ?? null;
    this.glow = options.glow ?? false;
    this.program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.textureProgram = createProgram(gl, TEXTURE_VERTEX_SHADER, TEXTURE_FRAGMENT_SHADER);
    this.buffer = required(gl.createBuffer(), "Unable to create particle buffer.");
    this.vao = required(gl.createVertexArray(), "Unable to create vertex array.");
    this.texture = required(gl.createTexture(), "Unable to create frame texture.");

    const positionLocation = gl.getAttribLocation(this.program, "a_position");
    const colorLocation = gl.getAttribLocation(this.program, "a_color");

    this.pointSizeLocation = required(
      gl.getUniformLocation(this.program, "u_pointSize"),
      "Missing u_pointSize uniform."
    );
    this.modeLocation = required(gl.getUniformLocation(this.program, "u_mode"), "Missing u_mode uniform.");
    this.glowLocation = required(gl.getUniformLocation(this.program, "u_glow"), "Missing u_glow uniform.");
    this.textureModeLocation = required(
      gl.getUniformLocation(this.textureProgram, "u_mode"),
      "Missing texture u_mode uniform."
    );

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.UNSIGNED_SHORT, true, 8, 0);
    gl.enableVertexAttribArray(colorLocation);
    gl.vertexAttribPointer(colorLocation, 4, gl.UNSIGNED_BYTE, true, 8, 4);
    gl.bindVertexArray(null);

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  setMode(mode: RenderMode): void {
    this.mode = mode;
  }

  setPointSize(size: number): void {
    this.pointSize = size > 0 ? size : null;
  }

  setSourceSize(width: number, height: number): void {
    this.sourceWidth = Math.max(1, width);
    this.sourceHeight = Math.max(1, height);
  }

  setGlow(enabled: boolean): void {
    this.glow = enabled;
  }

  resize(): void {
    const canvas = this.gl.canvas as HTMLCanvasElement;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    this.gl.viewport(0, 0, width, height);
  }

  clear(): void {
    this.resize();
    this.gl.clearColor(0.015, 0.018, 0.025, 1);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  render(frame: DecodedFrame): void {
    const gl = this.gl;
    this.lastParticleCount = frame.particleCount;
    this.resize();
    gl.clearColor(0.015, 0.018, 0.025, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (frame.rgb565) {
      this.renderRgb565(frame.rgb565);
      return;
    }

    if (frame.denseRgba) {
      this.renderRgba(frame.denseRgba);
      return;
    }

    gl.useProgram(this.program);
    gl.uniform1f(this.pointSizeLocation, this.getRenderPointSize());
    gl.uniform1i(this.modeLocation, modeToInt(this.mode));
    gl.uniform1i(this.glowLocation, this.glow ? 1 : 0);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, frame.interleaved, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.POINTS, 0, frame.particleCount);
    gl.bindVertexArray(null);
  }

  private renderRgba(rgba: Uint8Array): void {
    const gl = this.gl;
    gl.useProgram(this.textureProgram);
    gl.uniform1i(this.textureModeLocation, modeToInt(this.mode));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.ensureTextureStorage("rgba");
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      this.sourceWidth,
      this.sourceHeight,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      rgba
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  private renderRgb565(rgb565: Uint16Array): void {
    const gl = this.gl;
    gl.useProgram(this.textureProgram);
    gl.uniform1i(this.textureModeLocation, modeToInt(this.mode));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.ensureTextureStorage("rgb565");
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      this.sourceWidth,
      this.sourceHeight,
      gl.RGB,
      gl.UNSIGNED_SHORT_5_6_5,
      rgb565
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  private ensureTextureStorage(format: "rgba" | "rgb565"): void {
    const gl = this.gl;
    if (this.textureWidth === this.sourceWidth && this.textureHeight === this.sourceHeight && this.textureFormat === format) {
      return;
    }

    this.textureWidth = this.sourceWidth;
    this.textureHeight = this.sourceHeight;
    this.textureFormat = format;

    if (format === "rgba") {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.sourceWidth, this.sourceHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGB,
        this.sourceWidth,
        this.sourceHeight,
        0,
        gl.RGB,
        gl.UNSIGNED_SHORT_5_6_5,
        null
      );
    }
  }

  private getRenderPointSize(): number {
    if (this.pointSize !== null) return this.pointSize;

    const canvas = this.gl.canvas as HTMLCanvasElement;
    const dpr = window.devicePixelRatio || 1;
    const horizontalStep = canvas.width / this.sourceWidth;
    const verticalStep = canvas.height / this.sourceHeight;
    const sourcePixels = this.sourceWidth * this.sourceHeight;
    const coverage = this.lastParticleCount > 0 ? this.lastParticleCount / sourcePixels : 1;
    const sparseMultiplier = Math.max(1.2, Math.min(2.8, 1 / Math.sqrt(Math.max(0.12, coverage))));
    const modeMultiplier = this.mode === "normal" ? sparseMultiplier : Math.max(1.1, sparseMultiplier * 0.82);
    return Math.max(1.5 * dpr, Math.min(horizontalStep, verticalStep) * modeMultiplier);
  }
}

function createProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = required(gl.createProgram(), "Unable to create shader program.");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "Unable to link shader program.");
  }

  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  return program;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = required(gl.createShader(type), "Unable to create shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "Unable to compile shader.");
  }

  return shader;
}

function modeToInt(mode: RenderMode): number {
  return ["normal", "neon", "matrix", "wireframe"].indexOf(mode);
}

function required<T>(value: T | null, message: string): T {
  if (value === null) throw new Error(message);
  return value;
}
