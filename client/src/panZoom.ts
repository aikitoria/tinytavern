type Point = { clientX: number; clientY: number };
const distance = (a: Point, b: Point) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

/** Mutable gesture state; callers own hit testing, zoom bounds and frame scheduling. */
export function createPanZoom(
  camera: { x: number; y: number; scale: number },
  apply: () => void,
  zoomAt: (x: number, y: number, scale: number) => void,
) {
  let grabX = 0;
  let grabY = 0;
  let pinchDistance = 0;
  let pinchScale = 1;
  let middleX = 0;
  let middleY = 0;
  return {
    startPan(point: Point) {
      grabX = point.clientX - camera.x;
      grabY = point.clientY - camera.y;
    },
    pan(point: Point) {
      camera.x = point.clientX - grabX;
      camera.y = point.clientY - grabY;
      apply();
    },
    startPinch(a: Point, b: Point) {
      pinchDistance = distance(a, b);
      pinchScale = camera.scale;
      middleX = (a.clientX + b.clientX) / 2;
      middleY = (a.clientY + b.clientY) / 2;
    },
    pinch(a: Point, b: Point) {
      if (!pinchDistance) return;
      const x = (a.clientX + b.clientX) / 2;
      const y = (a.clientY + b.clientY) / 2;
      camera.x += x - middleX;
      camera.y += y - middleY;
      middleX = x;
      middleY = y;
      zoomAt(x, y, pinchScale * (distance(a, b) / pinchDistance));
    },
  };
}
