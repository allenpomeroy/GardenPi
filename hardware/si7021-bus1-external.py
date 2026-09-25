#!/opt/garden/python3/bin/python3
#
# si-internal-display.py
#

# Si7021
import time
import smbus2
from smbus2 import i2c_msg

# Si7021
I2C_BUS = 1        # software I2C bus
SI7021_ADDR = 0x40
CMD_MEASURE_TEMP_NOHOLD = 0xF3
CMD_MEASURE_RH_NOHOLD   = 0xF5
CMD_RESET               = 0xFE
bus = smbus2.SMBus(I2C_BUS)


def read_sensor_data(command):
    # Send measurement command
    write = i2c_msg.write(SI7021_ADDR, [command])
    bus.i2c_rdwr(write)
    
    # Wait for conversion (humidity: 22ms max, temp: 11ms max)
    time.sleep(0.03)
    
    # read 3 bytes (MSB, LSB, CRC)
    read = i2c_msg.read(SI7021_ADDR, 3)
    bus.i2c_rdwr(read)
    return list(read)


def main():
    # 
    # Reset sensor
    bus.write_byte(SI7021_ADDR, CMD_RESET)
    time.sleep(0.05)

    # Read humidity
    raw = read_sensor_data(CMD_MEASURE_RH_NOHOLD)
    rh_code = (raw[0] << 8) | raw[1]
    humidity = (125.0 * rh_code / 65536.0) - 6.0

    # Read temperature
    raw = read_sensor_data(CMD_MEASURE_TEMP_NOHOLD)
    t_code = (raw[0] << 8) | raw[1]
    temperature = (175.72 * t_code / 65536.0) - 46.85
    farenheit = (temperature*9/5)+32

    text = f"{farenheit:.0f}F  {humidity:.0f}%"

    print(f"Temp: {temperature:.2f}C  {farenheit:.2f}F  Humidity: {humidity:.2f}%")



if __name__ == "__main__":
    main()

