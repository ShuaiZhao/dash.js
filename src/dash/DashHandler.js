/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */
import FragmentRequest from '../streaming/vo/FragmentRequest';
import Error from '../streaming/vo/Error';
import {HTTPRequest} from '../streaming/vo/metrics/HTTPRequest';
import Events from '../core/events/Events';
import EventBus from '../core/EventBus';
import FactoryMaker from '../core/FactoryMaker';
import Debug from '../core/Debug';
import URLUtils from '../streaming/utils/URLUtils';
import Representation from './vo/Representation';

import {replaceTokenForTemplate, getTimeBasedSegment, getSegmentByIndex} from './utils/SegmentsUtils';
import SegmentsGetter from './utils/SegmentsGetter';

import SegmentBaseLoader from './SegmentBaseLoader';
import WebmSegmentBaseLoader from './WebmSegmentBaseLoader';

const SEGMENTS_UNAVAILABLE_ERROR_CODE = 1;

function DashHandler(config) {

    let context = this.context;
    let eventBus = EventBus(context).getInstance();
    const urlUtils = URLUtils(context).getInstance();

    let segmentBaseLoader;
    let timelineConverter = config.timelineConverter;
    let dashMetrics = config.dashMetrics;
    let metricsModel = config.metricsModel;
    const baseURLController = config.baseURLController;

    let instance,
        log,
        index,
        requestedTime,
        isDynamic,
        type,
        currentTime,
        earliestTime,
        streamProcessor,
        segmentsGetter;

    function setup() {
        log = Debug(context).getInstance().log.bind(instance);
        index = -1;
        currentTime = 0;
        earliestTime = NaN;

        segmentBaseLoader = isWebM(config.mimeType) ? WebmSegmentBaseLoader(context).getInstance() : SegmentBaseLoader(context).getInstance();
        segmentBaseLoader.setConfig({
            baseURLController: baseURLController,
            metricsModel: metricsModel
        });

        eventBus.on(Events.INITIALIZATION_LOADED, onInitializationLoaded, instance);
        eventBus.on(Events.SEGMENTS_LOADED, onSegmentsLoaded, instance);
    }

    function isWebM (mimeType) {
        let type = mimeType.split('/')[1];

        return 'webm' === type.toLowerCase();
    }

    function initialize(StreamProcessor) {
        streamProcessor = StreamProcessor;
        type = streamProcessor.getType();
        isDynamic = streamProcessor.isDynamic();

        segmentBaseLoader.initialize();

        segmentsGetter = SegmentsGetter(context).create(config, isDynamic);
    }

    function getStreamProcessor() {
        return streamProcessor;
    }

    function setCurrentTime(value) {
        currentTime = value;
    }

    function getCurrentTime() {
        return currentTime;
    }

    function getCurrentIndex() {
        return index;
    }

    function getEarliestTime() {
        return earliestTime;
    }

    function getType() {
        return type;
    }

    function reset() {
        segmentsGetter = null;
        currentTime = 0;
        earliestTime = NaN;
        requestedTime = NaN;
        index = -1;
        isDynamic = null;
        type = null;
        streamProcessor = null;
        eventBus.off(Events.INITIALIZATION_LOADED, onInitializationLoaded, instance);
        eventBus.off(Events.SEGMENTS_LOADED, onSegmentsLoaded, instance);
    }

    function unescapeDollarsInTemplate(url) {
        return url ? url.split('$$').join('$') : url;
    }

    function replaceIDForTemplate(url, value) {
        if (value === null || url === null || url.indexOf('$RepresentationID$') === -1) { return url; }
        var v = value.toString();
        return url.split('$RepresentationID$').join(v);
    }

    function setRequestUrl(request, destination, representation) {
        var baseURL = baseURLController.resolve(representation.path);
        var url;
        var serviceLocation;

        if (!baseURL || (destination === baseURL.url) || (!urlUtils.isRelative(destination))) {
            url = destination;
        } else {
            url = baseURL.url;
            serviceLocation = baseURL.serviceLocation;

            if (destination) {
                url = urlUtils.resolve(destination, url);
            }
        }

        if (urlUtils.isRelative(url)) {
            return false;
        }

        request.url = url;
        request.serviceLocation = serviceLocation;

        return true;
    }

    function generateInitRequest(representation, mediaType) {

        const request = new FragmentRequest();
        const period = representation.adaptation.period;
        const presentationStartTime = period.start;

        request.mediaType = mediaType;
        request.type = HTTPRequest.INIT_SEGMENT_TYPE;
        request.range = representation.range;
        request.availabilityStartTime = timelineConverter.calcAvailabilityStartTimeFromPresentationTime(presentationStartTime, period.mpd, isDynamic);
        request.availabilityEndTime = timelineConverter.calcAvailabilityEndTimeFromPresentationTime(presentationStartTime + period.duration, period.mpd, isDynamic);
        request.quality = representation.index;
        request.mediaInfo = streamProcessor.getMediaInfo();
        request.representationId = representation.id;

        if (setRequestUrl(request, representation.initialization, representation)) {
            return request;
        }
    }

    function getInitRequest(representation) {
        if (!representation) return null;
        const request = generateInitRequest(representation, type);
        return request;
    }

    function isMediaFinished(representation) {

        let isFinished = false;

        if (!isDynamic && index === representation.availableSegmentsNumber) {
            isFinished = true;
        } else {
            const seg = getSegmentByIndex(index, representation);
            if (seg) {
                const time = seg.presentationStartTime - representation.adaptation.period.start;
                const duration = representation.adaptation.period.duration;
                log(representation.segmentInfoType + ': ' + time + ' / ' + duration);
                isFinished = representation.segmentInfoType === 'SegmentTimeline' && isDynamic ? false : time >= duration;
            }
        }

        return isFinished;
    }

    function updateSegments(representation) {
        return segmentsGetter.getSegments(representation, requestedTime, index, onSegmentListUpdated);
    }

    function onSegmentListUpdated(representation, segments) {

        representation.segments = segments;

        if (segments && segments.length > 0) {
            earliestTime = isNaN(earliestTime) ? segments[0].presentationStartTime : Math.min(segments[0].presentationStartTime,  earliestTime);
            if (isDynamic && isNaN(timelineConverter.getExpectedLiveEdge())) {
                const lastSegment = segments[segments.length - 1];
                const liveEdge = lastSegment.presentationStartTime;
                const metrics = metricsModel.getMetricsFor('stream');
                // the last segment is the Expected, not calculated, live edge.
                timelineConverter.setExpectedLiveEdge(liveEdge);
                metricsModel.updateManifestUpdateInfo(dashMetrics.getCurrentManifestUpdate(metrics), {presentationStartTime: liveEdge});
            }
        }
    }

    function updateSegmentList(representation) {

        if (!representation) {
            throw new Error('no representation');
        }

        representation.segments = null;

        updateSegments(representation);

        return representation;
    }

    function updateRepresentation(representation, keepIdx) {
        var hasInitialization = Representation.hasInitialization(representation);
        var hasSegments = Representation.hasSegments(representation);
        var error;

        if (!representation.segmentDuration && !representation.segments) {
            updateSegmentList(representation);
        }

        representation.segmentAvailabilityRange = null;
        representation.segmentAvailabilityRange = timelineConverter.calcSegmentAvailabilityRange(representation, isDynamic);

        if ((representation.segmentAvailabilityRange.end < representation.segmentAvailabilityRange.start) && !representation.useCalculatedLiveEdgeTime) {
            error = new Error(SEGMENTS_UNAVAILABLE_ERROR_CODE, 'no segments are available yet', {availabilityDelay: representation.segmentAvailabilityRange.start - representation.segmentAvailabilityRange.end});
            eventBus.trigger(Events.REPRESENTATION_UPDATED, {sender: this, representation: representation, error: error});
            return;
        }

        if (!keepIdx) index = -1;

        if (representation.segmentDuration) {
            updateSegmentList(representation);
        }

        if (!hasInitialization) {
            segmentBaseLoader.loadInitialization(representation);
        }

        if (!hasSegments) {
            segmentBaseLoader.loadSegments(representation, type, representation.indexRange);
        }

        if (hasInitialization && hasSegments) {
            eventBus.trigger(Events.REPRESENTATION_UPDATED, {sender: this, representation: representation});
        }
    }

    function getIndexForSegments(time, representation, timeThreshold) {
        var segments = representation.segments;
        var ln = segments ? segments.length : null;

        var idx = -1;
        var epsilon,
            frag,
            ft,
            fd,
            i;

        if (segments && ln > 0) {
            for (i = 0; i < ln; i++) {
                frag = segments[i];
                ft = frag.presentationStartTime;
                fd = frag.duration;
                epsilon = (timeThreshold === undefined || timeThreshold === null) ? fd / 2 : timeThreshold;
                if ((time + epsilon) >= ft &&
                    (time - epsilon) < (ft + fd)) {
                    idx = frag.availabilityIdx;
                    break;
                }
            }
        }

        return idx;
    }

    function getRequestForSegment(segment) {
        if (segment === null || segment === undefined) {
            return null;
        }

        var request = new FragmentRequest();
        var representation = segment.representation;
        var bandwidth = representation.adaptation.period.mpd.manifest.Period_asArray[representation.adaptation.period.index].
            AdaptationSet_asArray[representation.adaptation.index].Representation_asArray[representation.index].bandwidth;
        var url = segment.media;

        url = replaceTokenForTemplate(url, 'Number', segment.replacementNumber);
        url = replaceTokenForTemplate(url, 'Time', segment.replacementTime);
        url = replaceTokenForTemplate(url, 'Bandwidth', bandwidth);
        url = replaceIDForTemplate(url, representation.id);
        url = unescapeDollarsInTemplate(url);

        request.mediaType = type;
        request.type = HTTPRequest.MEDIA_SEGMENT_TYPE;
        request.range = segment.mediaRange;
        request.startTime = segment.presentationStartTime;
        request.duration = segment.duration;
        request.timescale = representation.timescale;
        request.availabilityStartTime = segment.availabilityStartTime;
        request.availabilityEndTime = segment.availabilityEndTime;
        request.wallStartTime = segment.wallStartTime;
        request.quality = representation.index;
        request.index = segment.availabilityIdx;
        request.mediaInfo = streamProcessor.getMediaInfo();
        request.adaptationIndex = representation.adaptation.index;

        if (setRequestUrl(request, url, representation)) {
            return request;
        }
    }

    function getSegmentRequestForTime(representation, time, options) {
        var request,
            segment,
            finished;

        var idx = index;

        var keepIdx = options ? options.keepIdx : false;
        var timeThreshold = options ? options.timeThreshold : null;
        var ignoreIsFinished = (options && options.ignoreIsFinished) ? true : false;

        if (!representation) {
            return null;
        }

        if (requestedTime !== time) { // When playing at live edge with 0 delay we may loop back with same time and index until it is available. Reduces verboseness of logs.
            requestedTime = time;
            log('Getting the request for ' + type + ' time : ' + time);
        }

        updateSegments(representation);
        index = getIndexForSegments(time, representation, timeThreshold);
        //Index may be -1 if getSegments needs to update again.  So after getSegments is called and updated then try to get index again.
        if (index < 0) {
            updateSegments(representation);
            index = getIndexForSegments(time, representation, timeThreshold);
        }

        if (index > 0) {
            log('Index for ' + type + ' time ' + time + ' is ' + index );
        }

        finished = !ignoreIsFinished ? isMediaFinished(representation) : false;
        if (finished) {
            request = new FragmentRequest();
            request.action = FragmentRequest.ACTION_COMPLETE;
            request.index = index;
            request.mediaType = type;
            request.mediaInfo = streamProcessor.getMediaInfo();
            log('Signal complete.', request);

        } else {
            segment = getSegmentByIndex(index, representation);
            request = getRequestForSegment(segment);
        }

        if (keepIdx && idx >= 0) {
            index = representation.segmentInfoType === 'SegmentTimeline' && isDynamic ? index : idx;
        }

        return request;
    }

    function generateSegmentRequestForTime(representation, time) {
        var step = (representation.segmentAvailabilityRange.end - representation.segmentAvailabilityRange.start) / 2;

        representation.segments = null;
        representation.segmentAvailabilityRange = {start: time - step, end: time + step};
        return getSegmentRequestForTime(representation, time, {keepIdx: false, ignoreIsFinished: true});
    }

    function getNextSegmentRequest(representation) {
        var request,
            segment,
            finished;

        if (!representation || index === -1) {
            return null;
        }

        requestedTime = null;
        index++;

        log('Getting the next request at index: ' + index);

        finished = isMediaFinished(representation);
        if (finished) {
            request = new FragmentRequest();
            request.action = FragmentRequest.ACTION_COMPLETE;
            request.index = index;
            request.mediaType = type;
            request.mediaInfo = streamProcessor.getMediaInfo();
            log('Signal complete.');
        } else {
            updateSegments(representation);
            segment = getSegmentByIndex(index, representation);
            request = getRequestForSegment(segment);
            if (!segment && isDynamic) {
                /*
                 Sometimes when playing dynamic streams with 0 fragment delay at live edge we ask for
                 an index before it is available so we decrement index back and send null request
                 which triggers the validate loop to rerun and the next time the segment should be
                 available.
                 */
                index-- ;
            }
        }

        return request;
    }

    function onInitializationLoaded(e) {
        var representation = e.representation;
        //log("Got an initialization.");
        if (!representation.segments) return;

        eventBus.trigger(Events.REPRESENTATION_UPDATED, {sender: this, representation: representation});
    }

    function onSegmentsLoaded(e) {
        if (e.error || (type !== e.mediaType)) return;

        var fragments = e.segments;
        var representation = e.representation;
        var segments = [];
        var count = 0;

        var i,
            len,
            s,
            seg;

        for (i = 0, len = fragments.length; i < len; i++) {
            s = fragments[i];

            seg = getTimeBasedSegment(
                timelineConverter,
                isDynamic,
                representation,
                s.startTime,
                s.duration,
                s.timescale,
                s.media,
                s.mediaRange,
                count);

            segments.push(seg);
            seg = null;
            count++;
        }

        representation.segmentAvailabilityRange = {start: segments[0].presentationStartTime, end: segments[len - 1].presentationStartTime};
        representation.availableSegmentsNumber = len;

        onSegmentListUpdated(representation, segments);

        if (!Representation.hasInitialization(representation)) return;

        eventBus.trigger(Events.REPRESENTATION_UPDATED, {sender: this, representation: representation});
    }

    instance = {
        initialize: initialize,
        getStreamProcessor: getStreamProcessor,
        getInitRequest: getInitRequest,
        getSegmentRequestForTime: getSegmentRequestForTime,
        getNextSegmentRequest: getNextSegmentRequest,
        getType: getType,
        generateSegmentRequestForTime: generateSegmentRequestForTime,
        updateRepresentation: updateRepresentation,
        setCurrentTime: setCurrentTime,
        getCurrentTime: getCurrentTime,
        getCurrentIndex: getCurrentIndex,
        getEarliestTime: getEarliestTime,
        reset: reset
    };

    setup();

    return instance;
}

DashHandler.__dashjs_factory_name = 'DashHandler';
let factory = FactoryMaker.getClassFactory(DashHandler);
factory.SEGMENTS_UNAVAILABLE_ERROR_CODE = SEGMENTS_UNAVAILABLE_ERROR_CODE;
FactoryMaker.updateClassFactory(DashHandler.__dashjs_factory_name, factory);
export default factory;
