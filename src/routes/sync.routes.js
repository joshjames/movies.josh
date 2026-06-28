// POST: /api/sync/metadata-refresh on au.server
router.post('/metadata-refresh', async (req, res) => {
    // Standard secure token authentication verification goes here...
    
    const { folderName, cloudAvailability } = req.body;
    const folderPath = path.join(MOVIES_DIR, folderName);
    const metaFilePath = path.join(folderPath, 'metadata.json');

    if (!fs.existsSync(metaFilePath)) {
        return res.status(404).send('Asset directory trace not found on this region node yet.');
    }

    try {
        let metadata = JSON.parse(fs.readFileSync(metaFilePath, 'utf-8'));
        
        // Merge the global availability data fields cleanly
        metadata.cloudAvailability = cloudAvailability;
        metadata.pipelineState.currentStep = 'COMPLETED'; // Advance sister state instantly

        // Commit to disk and auto-hydrate Redis in lockstep
        await MetadataRegistry.writeAndCommit(metaFilePath, folderName, metadata);

        res.sendStatus(200);
    } catch (err) {
        res.status(500).send(`Failed to sync incoming cross-region data block: ${err.message}`);
    }
});