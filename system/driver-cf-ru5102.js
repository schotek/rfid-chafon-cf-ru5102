const SerialPort = require('serialport')
const config = require("../settings.json")
const RFID = new SerialPort(config.RU5102.port, { baudRate: 57600}, function (err) { if (err) { return console.log('Error: ', err.message) } console.log("Reader connected!"); RFID.setMaxListeners(0); rfid_cf_ru5102_started = 1 })
const moment = require('moment')
const cmd = require("node-cmd")

var scanned_tags = []

// ******************************
// Start of exported functions
// ******************************

let readEPC = async () => {
    // Preparing command
    var command = Buffer.from([0x04, 0x00, 0x01])
    var packet = Buffer.concat([ command, crc(command)])
    // Sending command packet
    sendCommand(packet)
    // Reading response
    var data = await readResponse()
    // Parsing response
    if (!data) { return { status: "error"} }
    var epc = await parseEPC(data)
    if (epc.status == "ok") {
        var final_array = []
        for (var i = 0; i < epc.epcs.length; i++) {
            if (epc.epcs[i].status == "stored") { final_array.push(epc.epcs[i].epc) }
        }
        if (!final_array.length) {
            return { status: "known" }
        } else {
            return { status: "ok", count: epc.count, epcs: final_array }
        }
    } else {
        if (epc.error != "fb") { console.log("EPC error:", epcStatus(epc.error)) }
        return { status: "error", }
    }
}

// Request TID from reader based on card EPC (because of EPC C1G2 specs requirement)
// Neads: epc (EPC tag number), words_to_read (number of memory words to read), retries (how many retires if there is a reader error)
let readTID = async (epc, words_to_read, retries) => {
    // Preparing command
    var epc_buffer = Buffer.from(epc,"hex")
    var epc_buffer_length = countLengthWord((epc_buffer), 0)
    var mem = Buffer.from([0x02])                     // 0x00: Password memory; 0x01: EPC memory; 0x02: TID memory; 0x03: User memory
    var wordptr = Buffer.from([0x00])
    var bytes_to_read = "0x" + Math.floor(words_to_read/2).toString(16)
    var num = Buffer.from([bytes_to_read])
    var pwd = Buffer.from([0x00, 0x00, 0x00, 0x00])
    var mask = Buffer.from([0x00, 0x00])
    var command = Buffer.from([0x00, 0x02])
    var data = Buffer.concat([epc_buffer_length, epc_buffer, mem, wordptr, num, pwd, mask])
    var len = countLength(data,4)
    // Combining packet
    var packet = Buffer.concat([len, command, data])
    packet = combinePacket(packet)
    // Sending command packet
    var count = 0
    var reset = 0
    do {
        sendCommand(packet)
        var response = await readResponse()
        var response_array = Array.prototype.slice.call(response,0)
        if (response_array[3] != 0) {
            count++
        } else {
            var TID = await parseTID(response_array, words_to_read)
            reset = 1
        }
        if (count > retries) { reset = 1; var TID = { status: "error", errno: response_array[3].toString(16) } }
    } while (reset != 1) 
    return { status: "ok", tid: TID}
} 

var readInfo = async () => {
    var command = Buffer.from([0x04, 0x00, 0x21])
    var packet = Buffer.concat([ command, crc(command)])
    sendCommand(packet)
    var data = await readResponse()
    var array = Array.prototype.slice.call(data,0)
    console.log("Reader firmware: v" + array[4].toString() + "." +  array[5].toString(16))
    //console.log("RAW reader info:", data)
}

module.exports = { readEPC, readTID, readInfo }

// ******************************
// End of exported functions
// ******************************

sendCommand = function(packet) {
    return new Promise(function(resolve) {
        RFID.write(packet, function(err) {
            if (err) {
                console.log("Error on write:",err.message)
                resolve("error")
            }
        })
    })
}

readResponse = function() {
    return new Promise (function (resolve) {
        var data = ""
        RFID.on("data", function (data) {
            resolve (data)
        })
    })
}

let parseEPC = async (buffer) => {
        //console.log("EPC parser buffer",buffer)
    // Convert Buffer to array
    var data = Array.prototype.slice.call(buffer,0)
    // Parse packet
    var packet_length = data[0]
    var packet_addr = await twoPlacesHex(data[1].toString(16))
    var packet_cmd = await twoPlacesHex(data[2].toString(16))
    // Evaluate status
    var packet_status = data[3].toString(16)
    if (packet_status == "fb") { return { status: "error", error: "fb" } }      // Return status 0xFB when there is no tag in the effective field.
    // Evaulate number of scanned TAGs
    var epc_count = data[4]
        //console.log("We have", epc_count, "scanned TAGs")
    // Parse scanned TAGs EPCs
    var epc_len = [], epc = [], epc_temp = "", epc_len_position = 5, scanned_tags = []
    for (var count = 0; count < epc_count; count++) {
        epc_temp = "", epc_len[count] = data[epc_len_position], epc[count] = ""
        for (var i = (epc_len_position + 1); i < (epc_len_position + 1 + epc_len[count]); i++) {
            epc[count] += await twoPlaces(data[i])
        }
        epc_len_position = epc_len_position + epc_len[count] + 1
        // Saving scanned EPC to local array
        var exists = await checkEPC(epc[count])
        scanned_tags.push({ epc: epc[count], status: exists })
    }
    return { status: "ok", count: count, epcs: scanned_tags }
}

var parseTID = async (data, words_to_read) => {
    var tid = ""
    for (var i = 4; i < (words_to_read + 4); i++) {
        tid += await twoPlacesHex(data[i])
    }
    return tid
}

let checkEPC = async (epc) => {
    var current_unixtime = moment().unix()
    // Check, if epc is allready scanned
    var exists = isKnownEpc(epc)
    if (exists.status == "TRUE") {
        // Tag was previously scanned, checking his old
        var time = current_unixtime - scanned_tags[exists.position].unixtime
        if (time > scan_timeout) {
            // Is timeouted
            // Deleting old record
            scanned_tags.splice(exists.position,1)
            // Storing new record
            saveEPC(epc, current_unixtime)
        } else {
            // Not timeouted
            return "exists"
        }
    } else {
        // Tag is new, lets store them
        saveEPC(epc, current_unixtime)
    }
    return "stored"
}

let saveEPC = (epc, unixtime) => {
    var data = {
        epc: epc,
        unixtime: unixtime
    }
    scanned_tags.push(data)
}

let isKnownEpc = (epc) => {
    var stop = 0
    var exit = 0
    for (var i = 0; i < scanned_tags.length; i++) {
        if (scanned_tags[i].epc == epc) { stop = 1; exit = i }
    }
    if (stop == 1) { return { status: "TRUE", position: exit } } else { return { status: "FALSE", position: exit } }
}

let epcStatus = (status) => {
    if (status == "01") { return "Command over, and return inventoried tag’s EPC." }
    if (status == "02") { return "The reader does not get all G2 tags’ EPC before user-defined Inventory-ScanTime overflows. Command force quit, and returns inventoried tags’ EPC. " }
    if (status == "03") { return "The reader executes an Inventory command and gets many G2 tags’ EPC. Data can not be completed within in a message, and then send in multiple. " }
    if (status == "04") { return "The reader executes an Inventory command and gets G2 tags’ EPC too much, more than the storage capacity of reader, and returns inventoried tags’ EPC. " }
    if (status == "fb") { return "Returns status 0xFB when there is no tag in the effective field." }
}

let twoPlacesHex = async (data) => {
    var response = data.toString(16)
    if (response.length == 1) { 
        response = "0"+response
        
    }
    return response
}

let twoPlaces = async (number) => {
    var data = number.toString(16)
    if (data.length == 1) {
        data = "0" + data
    }
    return data
}

let combinePacket = (data) => {
    //var temp = Buffer.concat([ countLength(command, 2), command ])
    var packet = Buffer.concat([ data, crc(data)])
    return packet
}

let countLength = (data, offset) => {
    var count = 0
    for (var i = 0; i < data.length; i++) {
        count++
    }
    var number = count + offset
    var response = "0x" + number.toString(16)    // Plus two bytes of CRC
    return Buffer.from([response])
}

let countLengthWord = (data, offset) => {
    var count = 0
    for (var i = 0; i < data.length; i++) {
        count++
    }
    var number = (count / 2) + offset
    var response = "0x" + number.toString(16)    // Plus two bytes of CRC
    return Buffer.from([response])
}

let crc = (data) => {
    var PRESET_VALUE = 0xFFFF;
    var POLYNOMIAL = 0x8408;
    var uiCrcValue = PRESET_VALUE
    for(var i = 0; i < data.length; i++) {
        uiCrcValue = uiCrcValue ^ (data[i])
        for(var j = 0; j < 8; j++) {
            if(uiCrcValue & 0x0001) {
                uiCrcValue = (uiCrcValue >> 1) ^ POLYNOMIAL
            } else {
                uiCrcValue = (uiCrcValue >> 1)
            }
        }
    }
    var buf = Buffer.from(uiCrcValue.toString(16), 'hex')
    buf = Buffer.from([buf[1], buf[0]], 'hex')
    return buf
}

cmdRun = function(command) {
    return new Promise(function(resolve) {
        var data = cmd.get(command, function(err, data, stderr) {
            resolve(data)
        })
    })
}

let detectPort = async () => {
    var data = await cmdRun("dmesg | grep tty")
    console.log(data)
}
