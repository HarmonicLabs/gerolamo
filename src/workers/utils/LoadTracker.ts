
type WorkTimestamps = [ start: number, end: number ];

function getWorkTime( timestamp: WorkTimestamps, defaultEnd: number ): number
{
    const end = timestamp[1] <= 0 ? defaultEnd : timestamp[1];
    return end - timestamp[0];
}

export interface LoadTrackerConfig {
    maxAge: number;
    joinTollerance: number;
}

const defaultConfig: LoadTrackerConfig = Object.freeze({
    maxAge: 60_000, // 1 minute
    joinTollerance: 100 // .1 seconds
});

export interface Load {
    start: number;
    end: number;
    /* end - start */
    time: number;
    workTime: number;
    /* time - workTime */
    idle: number;
    /* workTime / time */
    workTimeRatio: number;
}

/** keeps track of the non-idle time of a worker */
export class LoadTracker
{
    private readonly timestamps: WorkTimestamps[] = [];
    readonly maxAge: number;
    readonly joinTollerance: number;

    constructor(
        config: Partial<LoadTrackerConfig> = defaultConfig
    ) {
        let { maxAge, joinTollerance } = config;
        maxAge = Number.isSafeInteger(maxAge) ? maxAge : defaultConfig.maxAge;
        joinTollerance = Number.isSafeInteger(joinTollerance) ? joinTollerance : defaultConfig.joinTollerance;
        this.maxAge = maxAge! >>> 0;
        this.joinTollerance = joinTollerance! & 0xffff;
    }

    getLoad(): Load
    {
        void this.cleanup();
        const end = performance.now();
        if( this.timestamps.length === 0 )
        {
            const start = end - this.maxAge;
            const time = end - start;
            return {
                start: start,
                end: end,
                time: time,
                workTime: 0,
                idle: time,
                workTimeRatio: 0
            };
        }

        const start = this.timestamps[0][0];
        const time = end - start;
        const workTime = this.timestamps.reduce( (acc, ts) => acc + getWorkTime(ts, end), 0 );
        return {
            start: start,
            end: end,
            time: time,
            workTime: workTime,
            idle: time - workTime,
            workTimeRatio: ( workTime * 100 ) / time
        };
    }

    /** start tracking a new work session */
    start(): void
    {
        const now = this.cleanup();
        const len = this.timestamps.length;
        if( len === 0 )
        {
            this.timestamps.push([ now, 0 ]);
            return;
        }
        const prevEnd = this.timestamps[len - 1][1];
        if( prevEnd <= 0 ) return; // already tracking
        if( now - prevEnd < this.joinTollerance )
        {
            // join with previous
            this.timestamps[len - 1][1] = 0;
            return;
        }

        // new work session
        this.timestamps.push([ now, 0 ]);
    }

    /** stop tracking the current work session */
    end(): void
    {
        const len = this.timestamps.length;
        if( len === 0 ) return; // nothing to end
        this.timestamps[len - 1][1] = this.cleanup();
    }

    isTracking(): boolean
    {
        const now = performance.now();
        const len = this.timestamps.length;
        if( len === 0 ) return false;
        const lastEnd = this.timestamps[len - 1][1];
        return (
            lastEnd <= 0
            || now - lastEnd <= this.joinTollerance
        ); 
    }

    time<T>( fn: () => T ): T
    {
        this.start();
        let result: T;
        try { result = fn(); }
        finally { this.end(); }
        return result;
    }

    /**
     * time in a promise is assumed to be work off the thread
     * 
     * eg. network comunications, file I/O, etc.
    **/
    async skipPromiseTime<T>( promise: Promise<T> ): Promise<T>
    {
        const wasTracking = this.isTracking();
        if( wasTracking )
        {
            this.end();
            try {
                return await promise;
            } finally {
                this.start();
            }
        }
        return promise;
    }

    /**
     * clears works ended more than `maxAge` milliseconds ago
     * 
     * @returns `performance.now()` before cleanup
     */
    private cleanup(): number
    {
        const now = performance.now();
        const limit = now - this.maxAge;
        let timestamp: WorkTimestamps;
        let end = 0;
        while( timestamp = this.timestamps[0] )
        {
            end = timestamp[1];
            if(
                end <= 0 // currently tracking
                || end > limit // within maxAge
            ) break;

            void this.timestamps.shift();
        }
        return now;
    }
}