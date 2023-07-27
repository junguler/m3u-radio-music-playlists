#!/bin/bash

# replace spaces in files with an underline
for i in *.m3u ; do sed -i 's/ /_/g' $i ; done

# check for none 200 response coded links
for i in *.m3u ; do for j in $(cat $i) ; do wget -S --spider -q -t 1 --max-redirect 0 $j 2>&1 | grep "HTTP/" | awk '{print $2}' | (cat ; echo $j ;) | paste -s -d " " >> A-$i ; echo -e "$i - $j" ; done ; done

# find links that have 200 response code and remove others
for i in A-*.m3u ; do cat $i | grep -B1 "200 " | sed -e 's/200 //g' -e 's/_/ /g' | awk 'length>3' | grep -A1 "#" | sed 's/ , /,/g' > A$i ; done

# remove extra fluff from file names
for i in AA-*.m3u ; do mv $i $(echo $i | sed 's/AA-//') ; done

# make the m3u files proper again by adding the header
for i in *.m3u ; do sed -i '1s/^/#EXTM3U\n/' $i ; done