// CSV URL
const CSV_URL = 'https://huggingface.co/datasets/kush1434/awg_retina_tomography_ui/resolve/main/retina_tomography_ui%20dataset.csv';

// Shared data structure
export let samplesData = { samples: [] };

// Color palette for auto-assigning colors
const colorPalette = [
  0x22cc55, 0x0077ff, 0xff6b35, 0x9b59b6,
  0xf1c40f, 0x1abc9c, 0xe74c3c, 0x3498db,
  0x2ecc71, 0xe67e22, 0x95a5a6, 0x34495e
];
let colorIndex = 0;

function getNextColor() {
  const color = colorPalette[colorIndex % colorPalette.length];
  colorIndex++;
  return color;
}

/**
 * Loads and parses CSV data from HuggingFace
 * @returns {Promise<Object>} Parsed samples data
 */
export async function loadCSVData() {
  const loadingIndicator = document.getElementById('loading-indicator');
  
  if (loadingIndicator) {
    loadingIndicator.style.display = 'block';
  }
  
  try {
    const response = await fetch(CSV_URL);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const csvText = await response.text();
    
    // Parse CSV
    const lines = csvText.trim().split('\n');
    const headers = lines[0].split(',');
    
    const samplesMap = new Map();
    
    // Process each line (skip header)
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      
      // Split CSV line
      const values = line.split(',');
      
      // Extract fields based on CSV structure:
      // sample_name, sample_link, file_name, seg_mesh_label, seg_mesh_link, notes
      const sampleName = values[0]?.trim();
      const sampleLink = values[1]?.trim();
      const fileName = values[2]?.trim();
      const segMeshLabel = values[3]?.trim();
      const segMeshLink = values[4]?.trim();
      
      // Skip invalid rows
      if (!sampleName || !fileName || !segMeshLink) {
        console.warn(`Skipping invalid row ${i}:`, line);
        continue;
      }
      
      // Create sample if it doesn't exist
      if (!samplesMap.has(sampleName)) {
        samplesMap.set(sampleName, {
          id: sampleName.toLowerCase().replace(/\s+/g, '_'),
          label: sampleName,
          link: sampleLink,
          structures: []
        });
      }
      
      // Add structure to sample
      const sample = samplesMap.get(sampleName);
      sample.structures.push({
        id: `${sample.id}_${fileName}`,
        label: segMeshLabel || fileName,
        path: segMeshLink,
        color: getNextColor(),
        opacity: fileName === 'eye' ? 0.2 : 1.0 // Special case: eye structures are transparent
      });
    }
    
    // Convert map to array
    samplesData.samples = Array.from(samplesMap.values());
    
    console.log('✅ CSV loaded successfully:', samplesData);
    return samplesData;
    
  } catch (error) {
    console.error('❌ Error loading CSV:', error);
    alert('Failed to load CSV data. Check console for details.');
    throw error;
  } finally {
    if (loadingIndicator) {
      loadingIndicator.style.display = 'none';
    }
  }
}

/**
 * Reset color index (useful if you need to reload data)
 */
export function resetColorIndex() {
  colorIndex = 0;
}

/**
 * Get the current samples data
 * @returns {Object} Current samples data
 */
export function getSamplesData() {
  return samplesData;
}
