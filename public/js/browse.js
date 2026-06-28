// public/js/browse.js
let currentTab = 'movies'; // State tracking

function switchTab(tabName) {
    currentTab = tabName;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`tab-${tabName}`).classList.add('active');
    
    // Clear and execute refresh
    executeGlobalSearch(document.getElementById('search-input').value);
}

async function executeGlobalSearch(query) {
    const resultsContainer = document.getElementById('results-grid');
    resultsContainer.innerHTML = '<div class="loader"></div>';
    
    // Unify backend aggregation routing paths
    const endpoint = currentTab === 'movies' 
        ? `/api/torrent/browse?q=${encodeURIComponent(query)}` 
        : `/api/torrent/browse-shows?q=${encodeURIComponent(query)}`; // Points to EZTV scrapper map
        
    const res = await fetch(endpoint);
    const data = await res.json();
    
    renderCatalogGrid(data.results);
}