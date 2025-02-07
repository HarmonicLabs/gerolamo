import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";

function generateHypocycloidPoints(
    k = 6,
    r = 20,
    steps = 100,
    rotationDegrees = 90,
    rounds = 1
): [x: number, y: number][]
{
    steps *= rounds;

    const points: [ x: number, y: number ][] = [];
    const rotationRadians = (rotationDegrees * Math.PI) / 180;

    const totSteps = steps * rounds;

    for (let i = 0; i <= totSteps; i++) {
        const theta = (2 * Math.PI * i) / steps;
        const x = r * (k - 1) * Math.cos(theta) + r * Math.cos((k - 1) * theta);
        const y = r * (k - 1) * Math.sin(theta) - r * Math.sin((k - 1) * theta);

        // Apply rotation
        const rotatedX = x * Math.cos(rotationRadians) - y * Math.sin(rotationRadians);
        const rotatedY = x * Math.sin(rotationRadians) + y * Math.cos(rotationRadians);

        points.push([rotatedX, rotatedY]);
    }
    return points;
};

function generateHypocycloidPath(
    k = 6,
    r = 20,
    steps = 100,
    rotationDegrees = 90,
    rounds = 1
): string
{
    return generateHypocycloidPoints(k, r, steps, rotationDegrees, rounds)
    .reduce((acc, [x, y], i) =>
        acc + `${i === 0 ? 'M' : 'L'} ${x} ${y} `, ''
    ) + 'Z';
}

function placeDots(
    k = 6,
    r = 20,
    steps = 100,
    rotationDegrees = 90,
    rounds = 1
)
{
    const points = generateHypocycloidPoints(k, r, steps, rotationDegrees, rounds);

    return points
    .map(([x, y]) => 
        `<circle cx="${x}" cy="${y}" r="2.7" fill="#0F2442"></circle>`
    ).join('\n');
}

const triangleK = 4;
const triangleR = 15;
function gen()
{
    const k = triangleK;
    const r = triangleR;
    const rotationDegrees = 45;
    return `
    <path d="${generateHypocycloidPath(k, r, 100, rotationDegrees, 1)}" stroke="#627EEA" stroke-width="2"></path>
    ${placeDots(k, r, k, rotationDegrees, 1)}
    `;
}

function genReverse()
{
    const k = triangleK;
    const r = 7.5;
    const rotationDegrees = 90;
    return `
    <path d="${generateHypocycloidPath(k, r, 100, rotationDegrees, 1)}" stroke="#627EEA" stroke-width="2"></path>
    ${placeDots(k, r, k, rotationDegrees, 1)}
    `;
}

void async function main() {
    const folderPath = "./assets";
    if( !existsSync( folderPath ) ) await mkdir( folderPath );
    
    await writeFile(
        "./assets/gerolamo-logo.svg",
`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="-100 -100 200 200" fill="none" version="1.1" xmlns:xlink="http://www.w3.org/1999/xlink">
<circle cx="0" cy="0" r="70" fill="#FCFDFE"></circle>
${gen()}
${genReverse()}
</svg>`  
    );
}()