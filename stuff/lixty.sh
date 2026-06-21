# get a list of all the stations
curl -s https://lixty.com/sitemap/index.xml | htmlq loc -t | while read url ; do curl -s "$url" | gunzip | htmlq loc -t >> all_urls.txt ; done
cat all_urls.txt | grep '/en/s/' | awk -F '/' '{print $6}' > stations.txt

# scrape everything
for i in $(cat stations.txt); do echo "Processing: $i"; curl -s http://l.lixty.com/en/s/$i > mep1; cat mep1 | htmlq ".text-xs> a" -t | paste -sd "_" | sed 's/_/___/g' | tr ' ' '_' > genr; cat mep1 | htmlq "body>div>div>div>div>table tr:nth-child(1) td, body>div>div>div>div>table tr:nth-child(3) td" -t | tr ' ' '_' | sed ':a; N; $!ba; s/\n/___/g' > lang; cat mep1 | htmlq "body>div>div>div>div>div>div>img" | awk -F '"' '{print $8}' | sed 's/?w=160//' > img; cat mep1 | htmlq -t h1 > count; cat mep1 | sed 's|\\||g' | grep -oP '"url":"\K[^"]*' | head -n 1 > strm; sed 's/___/\n/g' lang | while read -r l; do echo -e "#EXTINF:-1 tv-logo=\"$(cat img)\",$(cat count)\n$(cat strm)" >> "${l}.m3u"; done; sed 's/___/\n/g' genr | while read -r g; do sanitized=$(echo "$g" | sed "s|/|_|g; s|:|_|g; s|'|_|g"); echo -e "#EXTINF:-1 tv-logo=\"$(cat img)\",$(cat count)\n$(cat strm)" >> "${sanitized}.m3u"; done; done

# remove duplicates
for i in $(find . -type f -name "*.m3u") ; do cat $i | awk '!seen[$0]++{if(p&&/^https?:\/\//){print l;print}if($0~/^#EXTINF:/){p=1;l=$0;next}{p=0}}' > $(basename $i) ; echo -e $i ; done

# make the playlist proper by adding the header
for i in *.m3u ; do sed '1s/^/#EXTM3U\n/' $i > hold/$i ; done