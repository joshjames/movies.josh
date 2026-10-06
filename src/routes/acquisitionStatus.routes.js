// src/routes/acquisitionStatus.routes.js
// Thin HTTP surface over AcquisitionStatusService - the "own API endpoint"
// the acquisition-ux-overhaul plan's queue widget talks to. The service
// module itself is what every job state change already reports into (see
// PipelineQueueService.js's createJob/updateJob); this route is purely the
// read/dismiss side for the frontend widget, not another place that needs
// to know about pipeline internals.
'use strict';

const express = require('express');
const router = express.Router();

const AcquisitionStatusService = require('../services/AcquisitionStatusService');

function currentUserKey(req) {
    return String(req.cookies?.user_profile || '').toLowerCase().trim();
}

// GET /api/acquisition-status/mine - every acquisition currently in flight
// (or just-failed/manual) for the signed-in user, in the small stable
// vocabulary (searching/acquiring/processing/done/error/manual) - never the
// raw internal pipeline stage names.
router.get('/mine', async (req, res) => {
    const userKey = currentUserKey(req);
    if (!userKey) {
        return res.status(401).json({ success: false, error: 'Unauthorized: No active user profile found.' });
    }

    const items = await AcquisitionStatusService.getActiveForUser(userKey);
    return res.json({ success: true, items });
});

// GET /api/acquisition-status/:jobId - single-item lookup, for a widget
// that's already polling a specific job and just wants its latest state.
router.get('/:jobId', async (req, res) => {
    const userKey = currentUserKey(req);
    if (!userKey) {
        return res.status(401).json({ success: false, error: 'Unauthorized: No active user profile found.' });
    }

    const entry = await AcquisitionStatusService.getJobStatus(req.params.jobId);
    if (!entry || entry.userKey !== userKey) {
        return res.status(404).json({ success: false, error: 'No active acquisition found for that id.' });
    }
    return res.json({ success: true, item: entry });
});

// POST /api/acquisition-status/:jobId/dismiss - removes this item from the
// widget. Deliberately NOT a real cancel yet (doesn't touch the underlying
// pipeline job/torrent) - that's a separate, bigger follow-up (stopping an
// in-flight BullMQ job and/or qBittorrent download safely needs its own
// design pass, not bundled into the status-reporting interface itself).
router.post('/:jobId/dismiss', async (req, res) => {
    const userKey = currentUserKey(req);
    if (!userKey) {
        return res.status(401).json({ success: false, error: 'Unauthorized: No active user profile found.' });
    }

    const entry = await AcquisitionStatusService.getJobStatus(req.params.jobId);
    if (entry && entry.userKey !== userKey) {
        return res.status(403).json({ success: false, error: 'Not your acquisition.' });
    }

    await AcquisitionStatusService.clearJobStatus(req.params.jobId, userKey);
    return res.json({ success: true });
});

module.exports = router;
