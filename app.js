const delay = require("delay")
const func = require("./system/functions")
const ru5102 = require("./system/driver-cf-ru5102")
const config = require("./settings")

// Reader config
global.rfid_cf_ru5102_enabled = 1
global.rfid_cf_ru5102_started = 0
global.rfid_read_interval = config.RU5102.read_interval     // Reader scan interval (ms)
global.scan_timeout = config.RU5102.scan_timeout         // If scanned new tag, ignore for this amount of seconds

// Function to read Tag ECDs
let readTag = async () => {
    await ru5102.readInfo()
    do { await delay(1000) } while (rfid_cf_ru5102_started != 1)
    console.log("Reading EPC from RFID Reader")
    var response, tid
    do {
        await delay(rfid_read_interval)
        response = await ru5102.readEPC() 
        if (response.status == "ok") { 
            console.log("We have this EPCs:",response.epcs)
            for (var i = 0; i < response.epcs.length; i++) {
                console.log(" > Requesting TID for EPC ID:",response.epcs[i])
                tid = await ru5102.readTID(response.epcs[i],12,10)
                if (tid.status == "ok") { console.log(" > This TAGs TID is:", tid.tid) } else { console.log(" > There was a error reading TID")}
                await delay(10)
            }
            
        }
    } while (rfid_cf_ru5102_enabled == 1)
}

//setInterval(readTag,5000)
readTag()
