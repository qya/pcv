import type { DecodedFrame } from "../../shared/format";
import type { RenderMode } from "./WebGLPointRenderer";
import type { PointRenderer } from "./PointRenderer";

const SHADER_WGSL = `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) uv: vec2<f32>,
};

struct Uniforms {
  pointSize: f32,
  mode: u32,
  canvasWidth: f32,
  canvasHeight: f32,
};

@group(0) @binding(0) var<uniform> u_vals: Uniforms;

// Full-screen triangle coordinates
const FS_POSITIONS = array<vec2<f32>, 3>(
  vec2<f32>(-1.0, -1.0),
  vec2<f32>(3.0, -1.0),
  vec2<f32>(-1.0, 3.0)
);

// FS VS
@vertex
fn fs_main(@builtin(vertex_index) vertex_id: u32) -> VertexOutput {
  var out: VertexOutput;
  let pos = FS_POSITIONS[vertex_id];
  out.position = vec4<f32>(pos, 0.0, 1.0);
  out.uv = pos * 0.5 + 0.5;
  return out;
}

// Textured Frame FS (Normal, Neon, Matrix)
@group(0) @binding(1) var t_rgba: texture_2d<f32>;
@group(0) @binding(2) var s_sampler: sampler;
@group(0) @binding(3) var t_rgb565: texture_2d<u32>;

@fragment
fn fs_render_rgba(@location(1) uv: vec2<f32>) -> @location(0) vec4<f32> {
  var color = textureSample(t_rgba, s_sampler, vec2<f32>(uv.x, 1.0 - uv.y));
  
  if (u_vals.mode == 1u) { // Neon
    color = vec4<f32>(min(vec3<f32>(1.0), color.rgb * vec3<f32>(0.65, 1.15, 1.75) + vec3<f32>(0.04, 0.13, 0.2)), color.a);
  } else if (u_vals.mode == 2u) { // Matrix
    let luma = dot(color.rgb, vec3<f32>(0.299, 0.587, 0.114));
    color = vec4<f32>(0.03, max(0.18, luma), 0.06, color.a);
  }
  return color;
}

@fragment
fn fs_render_rgb565(@location(1) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let tex_size = textureDimensions(t_rgb565);
  let coords = vec2<i32>(
    i32(uv.x * f32(tex_size.x)),
    i32((1.0 - uv.y) * f32(tex_size.y))
  );
  let val = textureLoad(t_rgb565, coords, 0).r;
  
  // Extract RGB565 bits
  let r = f32((val >> 11u) & 0x1fu) / 31.0;
  let g = f32((val >> 5u) & 0x3fu) / 63.0;
  let b = f32(val & 0x1fu) / 31.0;
  var color = vec4<f32>(r, g, b, 1.0);

  if (u_vals.mode == 1u) { // Neon
    color = vec4<f32>(min(vec3<f32>(1.0), color.rgb * vec3<f32>(0.65, 1.15, 1.75) + vec3<f32>(0.04, 0.13, 0.2)), 1.0);
  } else if (u_vals.mode == 2u) { // Matrix
    let luma = dot(color.rgb, vec3<f32>(0.299, 0.587, 0.114));
    color = vec4<f32>(0.03, max(0.18, luma), 0.06, 1.0);
  }
  return color;
}

// Particle rendering (Instanced Quads)
struct Particle {
  posXY: u32,
  color: u32,
};

@group(0) @binding(1) var<storage, read> t_particles: array<Particle>;

const QUAD_POSITIONS = array<vec2<f32>, 6>(
  vec2<f32>(-0.5, -0.5),
  vec2<f32>( 0.5, -0.5),
  vec2<f32>(-0.5,  0.5),
  vec2<f32>(-0.5,  0.5),
  vec2<f32>( 0.5, -0.5),
  vec2<f32>( 0.5,  0.5)
);

@vertex
fn particle_vs(
  @builtin(vertex_index) vertex_id: u32,
  @builtin(instance_index) instance_id: u32
) -> VertexOutput {
  let particle = t_particles[instance_id];
  let p = QUAD_POSITIONS[vertex_id];

  // Unpack normalized position (each is 16-bit unsigned int) from packed 32-bit posXY
  let ux = particle.posXY & 0xffffu;
  let uy = particle.posXY >> 16u;
  let px = f32(ux) / 65535.0;
  let py = f32(uy) / 65535.0;

  // Unpack color (RGBA)
  let c = particle.color;
  let color = vec4<f32>(
    f32(c & 0xffu) / 255.0,
    f32((c >> 8u) & 0xffu) / 255.0,
    f32((c >> 16u) & 0xffu) / 255.0,
    f32((c >> 24u) & 0xffu) / 255.0
  );

  let base_clip = vec2<f32>(px * 2.0 - 1.0, 1.0 - py * 2.0);
  let size_offset = p * u_vals.pointSize * 2.0 / vec2<f32>(u_vals.canvasWidth, u_vals.canvasHeight);

  var out: VertexOutput;
  out.position = vec4<f32>(base_clip + size_offset, 0.0, 1.0);
  out.color = color;
  out.uv = p; // ranges from -0.5 to 0.5
  return out;
}

@fragment
fn particle_fs(in: VertexOutput) -> @location(0) vec4<f32> {
  let dist = length(in.uv);
  if (dist > 0.5) {
    discard;
  }
  
  var soft = 1.0;
  var color = in.color.rgb;

  if (u_vals.mode == 1u) { // Neon
    soft = smoothstep(0.5, 0.05, dist);
    color = min(vec3<f32>(1.0), color * vec3<f32>(0.6, 1.2, 1.8) + vec3<f32>(0.08, 0.2, 0.35));
  } else if (u_vals.mode == 2u) { // Matrix
    let luma = dot(color, vec3<f32>(0.299, 0.587, 0.114));
    color = vec3<f32>(0.05, max(0.22, luma), 0.08);
  } else if (u_vals.mode == 3u) { // Wireframe
    let edge = smoothstep(0.32, 0.5, dist);
    color = mix(vec3<f32>(0.0), color, edge);
    soft = edge;
  }

  return vec4<f32>(color, soft * in.color.a);
}
`;

export class WebGPUPointRenderer implements PointRenderer {
  private readonly context: GPUCanvasContext;
  private readonly presentationFormat: GPUTextureFormat;
  private sourceWidth = 160;
  private sourceHeight = 90;
  private mode: RenderMode = "normal";
  private pointSize: number | null = null;
  private lastParticleCount = 0;

  // GPU Resources
  private shaderModule!: GPUShaderModule;
  private uniformBuffer!: GPUBuffer;
  private sampler!: GPUSampler;

  // Textures
  private rgbaTexture: GPUTexture | null = null;
  private rgb565Texture: GPUTexture | null = null;

  // Particle Buffer
  private particleStorageBuffer: GPUBuffer | null = null;

  // Pipelines
  private rgbaPipeline!: GPURenderPipeline;
  private rgb565Pipeline!: GPURenderPipeline;
  private particlePipeline!: GPURenderPipeline;

  // Bind group layouts
  private textureBindGroupLayout!: GPUBindGroupLayout;

  // Bind groups
  private rgbaBindGroup: GPUBindGroup | null = null;
  private rgb565BindGroup: GPUBindGroup | null = null;
  private particleBindGroup: GPUBindGroup | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly device: GPUDevice,
    private readonly adapter: GPUAdapter
  ) {
    const context = canvas.getContext("webgpu");
    if (!context) {
      throw new Error("WebGPU context could not be acquired.");
    }
    this.context = context;
    this.presentationFormat = navigator.gpu.getPreferredCanvasFormat();

    this.context.configure({
      device: this.device,
      format: this.presentationFormat,
      alphaMode: "opaque"
    });

    this.initGpuResources();
  }

  private initGpuResources() {
    this.shaderModule = this.device.createShaderModule({
      code: SHADER_WGSL
    });

    this.uniformBuffer = this.device.createBuffer({
      size: 16, // 4 * f32/u32
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    this.sampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear"
    });

    // Create explicit texture bind group layout so unused texture slots are not optimized away
    this.textureBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
          buffer: { type: "uniform" }
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" }
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" }
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "uint" }
        }
      ]
    });

    const texturePipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.textureBindGroupLayout]
    });

    // Create pipelines
    this.rgbaPipeline = this.device.createRenderPipeline({
      layout: texturePipelineLayout,
      vertex: {
        module: this.shaderModule,
        entryPoint: "fs_main"
      },
      fragment: {
        module: this.shaderModule,
        entryPoint: "fs_render_rgba",
        targets: [{ format: this.presentationFormat }]
      },
      primitive: {
        topology: "triangle-list"
      }
    });

    this.rgb565Pipeline = this.device.createRenderPipeline({
      layout: texturePipelineLayout,
      vertex: {
        module: this.shaderModule,
        entryPoint: "fs_main"
      },
      fragment: {
        module: this.shaderModule,
        entryPoint: "fs_render_rgb565",
        targets: [{ format: this.presentationFormat }]
      },
      primitive: {
        topology: "triangle-list"
      }
    });

    this.particlePipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.shaderModule,
        entryPoint: "particle_vs"
      },
      fragment: {
        module: this.shaderModule,
        entryPoint: "particle_fs",
        targets: [
          {
            format: this.presentationFormat,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
                operation: "add"
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add"
              }
            }
          }
        ]
      },
      primitive: {
        topology: "triangle-list"
      }
    });
  }

  setSourceSize(width: number, height: number): void {
    this.sourceWidth = Math.max(1, width);
    this.sourceHeight = Math.max(1, height);
  }

  setMode(mode: RenderMode): void {
    this.mode = mode;
  }

  setPointSize(size: number): void {
    this.pointSize = size > 0 ? size : null;
  }

  clear(): void {
    const commandEncoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();
    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: textureView,
          clearValue: { r: 0.015, g: 0.018, b: 0.025, a: 1.0 },
          loadOp: "clear",
          storeOp: "store"
        }
      ]
    });
    renderPass.end();
    this.device.queue.submit([commandEncoder.finish()]);
  }

  render(frame: DecodedFrame): void {
    this.resizeCanvas();
    this.updateUniforms(frame.particleCount);

    const commandEncoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();
    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: textureView,
          clearValue: { r: 0.015, g: 0.018, b: 0.025, a: 1.0 },
          loadOp: "clear",
          storeOp: "store"
        }
      ]
    });

    if (frame.rgb565) {
      this.ensureRgb565Texture();
      this.device.queue.writeTexture(
        { texture: this.rgb565Texture! },
        frame.rgb565 as any,
        { bytesPerRow: this.sourceWidth * 2 },
        { width: this.sourceWidth, height: this.sourceHeight }
      );

      renderPass.setPipeline(this.rgb565Pipeline);
      renderPass.setBindGroup(0, this.rgbaBindGroup || this.createRgb565BindGroup());
      renderPass.draw(3);
    } else if (frame.denseRgba) {
      this.ensureRgbaTexture();
      this.device.queue.writeTexture(
        { texture: this.rgbaTexture! },
        frame.denseRgba as any,
        { bytesPerRow: this.sourceWidth * 4 },
        { width: this.sourceWidth, height: this.sourceHeight }
      );

      renderPass.setPipeline(this.rgbaPipeline);
      renderPass.setBindGroup(0, this.rgbaBindGroup || this.createRgbaBindGroup());
      renderPass.draw(3);
    } else if (frame.interleaved && frame.particleCount > 0) {
      this.ensureParticleBuffer(frame.interleaved.byteLength);
      this.device.queue.writeBuffer(this.particleStorageBuffer!, 0, frame.interleaved as any);

      renderPass.setPipeline(this.particlePipeline);
      renderPass.setBindGroup(0, this.particleBindGroup || this.createParticleBindGroup());
      renderPass.draw(6, frame.particleCount);
    }

    renderPass.end();
    this.device.queue.submit([commandEncoder.finish()]);
  }

  private updateUniforms(particleCount: number) {
    this.lastParticleCount = particleCount;
    const size = this.getRenderPointSize();
    const modeIdx = ["normal", "neon", "matrix", "wireframe"].indexOf(this.mode);

    const uniformArray = new ArrayBuffer(16);
    const view = new DataView(uniformArray);
    view.setFloat32(0, size, true);
    view.setUint32(4, modeIdx, true);
    view.setFloat32(8, this.canvas.width, true);
    view.setFloat32(12, this.canvas.height, true);

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformArray);
  }

  private resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  private getRenderPointSize(): number {
    if (this.pointSize !== null) return this.pointSize;
    const horizontalStep = this.canvas.width / this.sourceWidth;
    const verticalStep = this.canvas.height / this.sourceHeight;
    const sourcePixels = this.sourceWidth * this.sourceHeight;
    const coverage = this.lastParticleCount > 0 ? this.lastParticleCount / sourcePixels : 1;
    const sparseMultiplier = Math.max(1.2, Math.min(2.8, 1 / Math.sqrt(Math.max(0.12, coverage))));
    const modeMultiplier = this.mode === "normal" ? sparseMultiplier : Math.max(1.1, sparseMultiplier * 0.82);
    return Math.max(1.5, Math.min(horizontalStep, verticalStep) * modeMultiplier);
  }

  private ensureRgbaTexture() {
    if (this.rgbaTexture && this.rgbaTexture.width === this.sourceWidth && this.rgbaTexture.height === this.sourceHeight) {
      return;
    }
    this.rgbaTexture?.destroy();
    this.rgbaTexture = this.device.createTexture({
      size: [this.sourceWidth, this.sourceHeight],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    this.rgbaBindGroup = null;
  }

  private ensureRgb565Texture() {
    if (this.rgb565Texture && this.rgb565Texture.width === this.sourceWidth && this.rgb565Texture.height === this.sourceHeight) {
      return;
    }
    this.rgb565Texture?.destroy();
    this.rgb565Texture = this.device.createTexture({
      size: [this.sourceWidth, this.sourceHeight],
      format: "r16uint", // Store packed rgb565 integers directly
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    this.rgbaBindGroup = null;
  }

  private ensureParticleBuffer(byteLength: number) {
    if (this.particleStorageBuffer && this.particleStorageBuffer.size >= byteLength) {
      return;
    }
    this.particleStorageBuffer?.destroy();
    this.particleStorageBuffer = this.device.createBuffer({
      size: Math.max(byteLength, 1024 * 1024), // Min 1MB buffer
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.particleBindGroup = null;
  }

  private createRgbaBindGroup(): GPUBindGroup {
    this.ensureRgbaTexture();
    this.rgbaBindGroup = this.device.createBindGroup({
      layout: this.textureBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.rgbaTexture!.createView() },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: (this.rgb565Texture || this.rgbaTexture)!.createView() } // dummy placeholder
      ]
    });
    return this.rgbaBindGroup;
  }

  private createRgb565BindGroup(): GPUBindGroup {
    this.ensureRgb565Texture();
    this.ensureRgbaTexture(); // Ensure we have a dummy texture for slot 1
    this.rgbaBindGroup = this.device.createBindGroup({
      layout: this.textureBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.rgbaTexture!.createView() },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: this.rgb565Texture!.createView() }
      ]
    });
    return this.rgbaBindGroup;
  }

  private createParticleBindGroup(): GPUBindGroup {
    this.particleBindGroup = this.device.createBindGroup({
      layout: this.particlePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.particleStorageBuffer! } }
      ]
    });
    return this.particleBindGroup;
  }
}
