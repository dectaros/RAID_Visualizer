# RAID Visualizer

Interactive web visualizer for explaining how RAID levels work during normal reads, drive failures, and rebuilds.

Included layouts:
- RAID 0
- RAID 1
- RAID 0+1
- RAID 10
- RAID 5
- RAID 50
- RAID 6
- RAID 60
- ADAPT

## What It Is For

This project is meant for training and presales conversations. It focuses on making RAID behavior easy to understand visually:
- how data is distributed
- what happens when drives fail
- which data can still be read immediately
- what must be reconstructed
- how rebuild behavior differs between RAID types

It is a teaching tool, not a vendor-certified engineering simulator.

## How To Run

Open:

`start.html`

in a browser.

The start page lets you switch between RAID modes.

## Notes

- The left panel represents data read access.
- The drive panel represents array layout and rebuild behavior.
- ADAPT is shown here as an `N+2` distributed free-capacity model for training purposes.

