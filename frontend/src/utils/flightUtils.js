/**
 * Utility functions for flight tracking and airplane emoji rotation
 */

/**
 * Updates airplane emoji rotation based on flight heading
 * @param {HTMLElement} element - The DOM element containing the airplane emoji
 * @param {number|null|undefined} heading - Flight heading in degrees (0-360°)
 * 
 * Heading reference:
 * - 0° = North (↑)
 * - 90° = East (→)
 * - 180° = South (↓)
 * - 270° = West (←)
 * 
 * The ✈️ emoji naturally points northeast (~45°), so we subtract 45° to align it properly
 */
export const updatePlaneDirection = (element, heading) => {
    if (heading === null || heading === undefined) {
        // Default orientation when no heading data is available
        element.style.transform = 'rotate(-45deg)';
        return;
    }

    // Convert heading to rotation angle
    // The ✈️ emoji naturally points northeast (45°), so we subtract 45° to align it properly
    // Heading 0° (North) should point up, 90° (East) should point right, etc.
    const rotation = heading - 45;
    
    // Handle smooth transition across 360°/0° boundary
    const currentTransform = element.style.transform;
    const currentRotation = currentTransform ? parseFloat(currentTransform.match(/rotate\((-?\d+\.?\d*)deg\)/)?.[1] || 0) : 0;
    
    let targetRotation = rotation;
    
    // Calculate the shortest rotation path
    const diff = targetRotation - currentRotation;
    if (diff > 180) {
        targetRotation -= 360;
    } else if (diff < -180) {
        targetRotation += 360;
    }
    
    element.style.transform = `rotate(${targetRotation}deg)`;
};

/**
 * Example usage and test cases for the updatePlaneDirection function
 */
export const exampleUsage = () => {
    // Create a test airplane element
    const airplaneElement = document.createElement('div');
    airplaneElement.innerHTML = '✈️';
    airplaneElement.className = 'airplane-marker';
    airplaneElement.style.fontSize = '24px';
    airplaneElement.style.transition = 'transform 0.5s ease-out';
    airplaneElement.style.transformOrigin = 'center center';

    // Test different headings
    const testHeadings = [
        { heading: 0, description: 'North - plane points up' },
        { heading: 90, description: 'East - plane points right' },
        { heading: 180, description: 'South - plane points down' },
        { heading: 270, description: 'West - plane points left' },
        { heading: 45, description: 'Northeast - plane points up-right' },
        { heading: 135, description: 'Southeast - plane points down-right' },
        { heading: 225, description: 'Southwest - plane points down-left' },
        { heading: 315, description: 'Northwest - plane points up-left' },
        { heading: null, description: 'No heading data - default orientation' }
    ];

    console.log('Testing airplane emoji rotation:');
    testHeadings.forEach(({ heading, description }) => {
        updatePlaneDirection(airplaneElement, heading);
        const transform = airplaneElement.style.transform;
        console.log(`Heading: ${heading}° - ${description} - CSS: ${transform}`);
    });

    return airplaneElement;
};

/**
 * Convert heading degrees to compass direction
 * @param {number} heading - Heading in degrees (0-360°)
 * @returns {string} Compass direction (N, NE, E, SE, S, SW, W, NW)
 */
export const headingToCompass = (heading) => {
    if (heading === null || heading === undefined) return 'N/A';
    
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const index = Math.round(heading / 45) % 8;
    return directions[index];
};

/**
 * Calculate the difference between two headings (shortest path)
 * @param {number} from - Starting heading in degrees
 * @param {number} to - Target heading in degrees
 * @returns {number} Difference in degrees (-180 to 180)
 */
export const headingDifference = (from, to) => {
    let diff = to - from;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    return diff;
};
