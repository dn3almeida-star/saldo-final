import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const canvas = document.getElementById('prisma3d');
const wrap = canvas.closest('.car-wrap');
const status = document.getElementById('carStatus');
const buttons = [...document.querySelectorAll('[data-car-action]')];

async function start() {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = .95;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  scene.environment = pmrem.fromScene(room, .04).texture;
  room.dispose();
  pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x161616, .65));
  const key = new THREE.DirectionalLight(0xfff7ef, 2.5);
  key.position.set(-3, 7, -4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024,1024);
  Object.assign(key.shadow.camera,{left:-4,right:4,top:4,bottom:-4,near:.1,far:20});
  key.shadow.bias = -.0003;
  key.shadow.normalBias = .012;
  scene.add(key);
  const fillLight = new THREE.DirectionalLight(0xe9efff, 1.3);
  fillLight.position.set(5,3,1);
  scene.add(fillLight);
  const camera = new THREE.PerspectiveCamera(32, 1, .05, 100);
  const controls = new OrbitControls(camera, canvas);
  controls.enablePan = false;
  controls.enableRotate = false;
  controls.enableDamping = false;
  controls.minPolarAngle = .7;
  controls.maxPolarAngle = 1.46;
  controls.rotateSpeed = .7;
  controls.zoomSpeed = .6;
  // Let the page scroll normally. Zoom has accessible buttons and pinch.
  canvas.addEventListener('wheel', event => event.stopImmediatePropagation(), {capture: true});
  const gltf = await new GLTFLoader().loadAsync('./assets/prisma-hubcaps.glb');
  const vehicle = gltf.scene;
  vehicle.traverse(object => {
    if (!object.isMesh) return;
    object.castShadow = true;
    object.receiveShadow = true;
  });
  const bounds = new THREE.Box3().setFromObject(vehicle);
  const center = bounds.getCenter(new THREE.Vector3());
  const turntable = new THREE.Group();
  scene.add(turntable);
  vehicle.position.sub(center);
  vehicle.position.y += bounds.getSize(new THREE.Vector3()).y / 2;
  turntable.add(vehicle);
  const platform = new THREE.Mesh(
    new THREE.CylinderGeometry(2.65,2.65,.07,128),
    new THREE.MeshStandardMaterial({color:0x050505,roughness:1,metalness:0})
  );
  platform.position.y = -.035;
  platform.receiveShadow = true;
  turntable.add(platform);
  const pedestal = new THREE.Mesh(
    new THREE.CylinderGeometry(2.35,2.48,.10,128),
    new THREE.MeshStandardMaterial({color:0x14171c,roughness:.94,metalness:0})
  );
  pedestal.position.y = -.105;
  pedestal.castShadow = true;
  pedestal.receiveShadow = true;
  turntable.add(pedestal);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(2.63,.009,8,160),
    new THREE.MeshBasicMaterial({color:0x00c8f5})
  );
  ring.rotation.x = Math.PI/2;
  ring.position.y = .004;
  turntable.add(ring);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(20,20),
    new THREE.ShadowMaterial({color:0x000000,opacity:.30})
  );
  floor.rotation.x = -Math.PI/2;
  floor.position.y = -.16;
  floor.receiveShadow = true;
  scene.add(floor);
  const target = new THREE.Vector3(0, .60, 0);
  const homeDirection = new THREE.Vector3(0, .20, -1).normalize();
  const homeDistanceFactor = 1.25;
  controls.target.copy(target);
  let fittedDistance = 8;
  function render() { renderer.render(scene, camera); }
  function reset() {
    stopInertia();
    turntable.rotation.y = 0;
    fittedDistance = distanceFor(homeDirection) * homeDistanceFactor;
    camera.position.copy(target).add(homeDirection.clone().multiplyScalar(fittedDistance));
    controls.target.copy(target);
    controls.minDistance = fittedDistance*.58;
    controls.maxDistance = fittedDistance*1.5;
    controls.update();
    render();
  }
  function distanceFor(direction) {
    const size = bounds.getSize(new THREE.Vector3());
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0),direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction,right).normalize();
    const vFov = THREE.MathUtils.degToRad(camera.fov / 2);
    const hFov = Math.atan(Math.tan(vFov) * camera.aspect);
    let distance = 0;
    for (const x of [-size.x/2,size.x/2]) for (const y of [0,size.y]) for (const z of [-size.z/2,size.z/2]) {
      const corner = new THREE.Vector3(x,y,z).sub(target);
      distance = Math.max(distance,
        Math.abs(corner.dot(right))/Math.tan(hFov)+corner.dot(direction),
        Math.abs(corner.dot(up))/Math.tan(vFov)+corner.dot(direction));
    }
    return distance * 1.06;
  }
  const activePointers = new Set();
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let turntableVelocity = 0;
  let inertiaFrame = 0;
  let lastMoveTime = 0;
  let inertiaTime = 0;
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const maxRotationSpeed = 4;

  function stopInertia() {
    if (inertiaFrame) cancelAnimationFrame(inertiaFrame);
    inertiaFrame = 0;
    turntableVelocity = 0;
    inertiaTime = 0;
  }

  function stepInertia(timestamp) {
    if (prefersReducedMotion) {
      stopInertia();
      return;
    }
    if (!inertiaTime) inertiaTime = timestamp;
    const elapsed = Math.min(Math.max((timestamp - inertiaTime) / 1000, 0), .05);
    inertiaTime = timestamp;
    if (Math.abs(turntableVelocity) < .005) {
      turntableVelocity = 0;
      inertiaFrame = 0;
      return;
    }
    turntable.rotation.y += turntableVelocity * elapsed;
    turntableVelocity *= Math.pow(.90, elapsed / (1 / 60));
    render();
    inertiaFrame = requestAnimationFrame(stepInertia);
  }

  function beginInertia() {
    if (prefersReducedMotion) {
      turntableVelocity = 0;
      return;
    }
    if (!inertiaFrame && Math.abs(turntableVelocity) >= .005) {
      inertiaTime = 0;
      inertiaFrame = requestAnimationFrame(stepInertia);
    }
  }

  canvas.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    activePointers.add(event.pointerId);
    if (activePointers.size !== 1) {
      dragging = false;
      stopInertia();
      return;
    }
    stopInertia();
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    lastMoveTime = performance.now();
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener('pointermove', event => {
    if (!dragging || activePointers.size !== 1 || !activePointers.has(event.pointerId)) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    const rotation = dx * .008;
    const now = performance.now();
    const elapsed = Math.min(Math.max((now - lastMoveTime) / 1000, 1 / 240), .1);
    lastMoveTime = now;
    turntable.rotation.y += rotation;
    turntableVelocity = THREE.MathUtils.clamp(rotation / elapsed, -maxRotationSpeed, maxRotationSpeed);
    const offset = camera.position.clone().sub(target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.phi = THREE.MathUtils.clamp(
      spherical.phi - dy * .006,
      controls.minPolarAngle,
      controls.maxPolarAngle
    );
    camera.position.setFromSpherical(spherical).add(target);
    controls.update();
    render();
  });

  function finishPointer(event) {
    if (!activePointers.has(event.pointerId)) return;
    activePointers.delete(event.pointerId);
    if (activePointers.size === 0) {
      dragging = false;
      beginInertia();
    }
  }

  canvas.addEventListener('pointerup', finishPointer);
  canvas.addEventListener('pointercancel', finishPointer);
  canvas.addEventListener('lostpointercapture', finishPointer);
  function resize() {
    if (!wrap.clientWidth || !wrap.clientHeight) return;
    renderer.setSize(wrap.clientWidth, wrap.clientHeight, false);
    camera.aspect = wrap.clientWidth / wrap.clientHeight;
    camera.updateProjectionMatrix();
    reset();
  }
  controls.addEventListener('change', () => {
    // OrbitControls preserves the current radius while rotating.
    // Only an explicit zoom gesture or button changes the camera distance.
    render();
  });
  new ResizeObserver(resize).observe(wrap);
  buttons.forEach(button => {
    button.disabled = false;
    button.addEventListener('click', () => {
      if (button.dataset.carAction === 'reset') return reset();
      const factor = button.dataset.carAction === 'in' ? .85 : 1.18;
      const offset = camera.position.clone().sub(controls.target);
      offset.setLength(THREE.MathUtils.clamp(offset.length() * factor, controls.minDistance, controls.maxDistance));
      camera.position.copy(controls.target).add(offset);
      controls.update();
      render();
    });
  });
  canvas.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    stopInertia();
    turntable.rotation.y += event.key === 'ArrowLeft' ? -.15 : .15;
    render();
  });
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    wrap.classList.remove('webgl-ready');
    status.textContent = 'A visualização foi interrompida. Recarregue a página.';
  });
  resize();
  wrap.classList.add('webgl-ready');
  status.textContent = 'Arraste para girar';
  wrap.dataset.model = 'ready';
}

start().catch(error => {
  status.textContent = 'Não foi possível abrir o carro. Recarregue a página.';
  wrap.dataset.model = 'error';
  console.error('Prisma viewer:', error);
});
