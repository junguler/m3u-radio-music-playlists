#!/bin/bash

# inplace remove the first line in all files
find . -type f -exec sed -i '1d' {} \;

# split files to 1000 lines
for i in *.m3u ; do split -l 1000 $i --suffix-length=4 --additional-suffix=.txt $i ; done

# replace extra .m3u extension to ___
for i in *.txt ; do mv $i $(echo $i | sed "s|.m3u|___|g") ; done

# place every file to a folder ending with the last 4 letter
for i in *.txt ; do dir=$( echo $i | awk -F '___' '{print $2}' | sed 's|.txt||g') ; mkdir -p $dir ; mv $i $dir ; done

# move all newly made status coded files to a folder
# check for 200 status code
for i in *.txt ; do cat $i | grep -B1 "200 " | sed 's/200 //g' | awk 'length>3' | grep -A1 "#" > A$i ; done

# remove empty files
find . -type f -empty -name "*.txt" -delete ; mkdir combined

# replace underline in stream titles with space
for i in *.txt ; do sed -i '/#/s/_/ /g' $i ; done

# combine 
for i in *.txt ; do cat $i >> combined/$(echo $i | awk -F '___' '{print $1}').txt ; done

# for combining everything
for i in $(find . -type f -name "*.txt") ; do (cat "${i}"; echo) | grep -v "#EXTM3U" >> $(basename $i) ; done

# fix extension
for i in *.txt ; do mv $i $(echo $i | sed "s|.txt|.m3u|g") ; done

# remove empty lines
for i in *.m3u ; do sed -i '/^$/d' $i ; done

# make m3u files proper by adding back the header
for i in *.m3u ; do sed -i '1s/^/#EXTM3U\n/' $i ; done

# place every file to a folder named to the first character of the file name
for i in *.m3u ; do dir=$(echo $i | cut -c 1 -) ; mkdir -p $dir ; mv $i $dir ; done