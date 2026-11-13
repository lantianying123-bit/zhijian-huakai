export const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));

export function handOpenness(landmarks, width, height) {
  const distance = (first, second) => Math.hypot(
    (landmarks[first].x - landmarks[second].x) * width,
    (landmarks[first].y - landmarks[second].y) * height,
  );

  // Use palm size as the reference so moving toward the lens does not open the flower.
  const palmSize = (distance(0, 9) + distance(5, 17)) / 2;
  if (palmSize < Math.min(width, height) * 0.045) return null;
  const gap = distance(4, 8) / palmSize;
  return clamp((gap - 0.20) / (1.40 - 0.20));
}

export function approach(current, target, elapsedMs) {
  const difference = target - current;
  if (Math.abs(difference) < 0.0015) return target;
  // Faster deliberate motions need less damping than small, noisy movements.
  const timeConstant = 155 - 70 * clamp(Math.abs(difference) / 0.33);
  return current + difference * (1 - Math.exp(-elapsedMs / timeConstant));
}
